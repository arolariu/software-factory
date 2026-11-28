#![cfg(windows)]

use std::{
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    mem::size_of,
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::Path,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    ptr::null,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    },
    Threading::CREATE_NO_WINDOW,
};
use zeroize::Zeroizing;

const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);

fn lock_instance(data_dir: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data_dir.join("desktop-instance.lock"))?;
    file.try_lock().map_err(io::Error::from)?;
    Ok(file)
}

fn create_job() -> io::Result<OwnedHandle> {
    let raw = unsafe { CreateJobObjectW(null(), null()) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // The unnamed job handle is not inherited by the child.
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let success = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

fn read_ready(output: impl Read) -> io::Result<u16> {
    let mut line = String::new();
    BufReader::new(output.take(32)).read_line(&mut line)?;
    let startup_error = match line.as_str() {
        "error owner\n" => Some(
            "The GitHub App does not match the Factory owner. Restore the original app or rebind the owner.",
        ),
        "error vault\n" => Some(
            "The credential vault could not be opened. Check the Windows account and vault key.",
        ),
        "error assets\n" => {
            Some("Packaged portal files are missing or invalid. Reinstall the desktop runtime.")
        }
        "error locked\n" => Some("Another Factory process owns this data directory."),
        "error startup\n" => Some(
            "The Factory sidecar could not start. Check the data directory and runtime configuration.",
        ),
        _ => None,
    };
    if let Some(message) = startup_error {
        return Err(io::Error::other(message));
    }
    let port = line
        .strip_prefix("ready ")
        .and_then(|value| value.strip_suffix('\n'))
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value != 0 && line == format!("ready {value}\n"));
    port.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid desktop readiness frame.",
        )
    })
}

pub struct Sidecar {
    child: Child,
    control: Option<ChildStdin>,
    _job: OwnedHandle,
    _lock: File,
    token: Zeroizing<[u8; 32]>,
    port: u16,
}

impl Sidecar {
    /// Starts the bundled runtime. Both paths must come from the native app, never from a web request.
    pub fn start(
        stage: &Path,
        data_dir: &Path,
        github_client_id: Option<&str>,
    ) -> io::Result<Self> {
        let stage = fs::canonicalize(stage)?;
        let data_dir = fs::canonicalize(data_dir)?;
        let lock = lock_instance(&data_dir)?;
        let key = factory_desktop_vault_key::load_or_initialize(&data_dir)?;
        let mut token = Zeroizing::new([0_u8; 32]);
        getrandom::fill(token.as_mut_slice())
            .map_err(|_| io::Error::other("Could not generate the desktop channel token."))?;
        let job = create_job()?;
        let mut command = Command::new(stage.join("node.exe"));
        command
            .arg(stage.join(r"dist\server\management\desktop-sidecar.js"))
            .arg(data_dir)
            .current_dir(&stage)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("NODE_TLS_REJECT_UNAUTHORIZED");
        if let Some(client_id) = github_client_id {
            command.arg(client_id);
        }
        let mut child = command.spawn()?;
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let control = child.stdin.take();
        let output = child.stdout.take();
        let mut started = Self {
            child,
            control,
            _job: job,
            _lock: lock,
            token,
            port: 0,
        };
        let input = started
            .control
            .as_mut()
            .ok_or_else(|| io::Error::other("Desktop control pipe is unavailable."))?;
        let output =
            output.ok_or_else(|| io::Error::other("Desktop readiness pipe is unavailable."))?;
        let mut frame = Zeroizing::new([0_u8; 64]);
        frame[..32].copy_from_slice(started.token.as_slice());
        frame[32..].copy_from_slice(key.as_slice());
        input.write_all(frame.as_slice())?;
        drop(frame);
        drop(key);
        let (send, receive) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("factory-desktop-ready".into())
            .spawn(move || {
                let _ = send.send(read_ready(output));
            })?;
        started.port = receive.recv_timeout(START_TIMEOUT).map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "Desktop readiness was not received.",
            )
        })??;
        Ok(started)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Only the native proxy may attach this token to sidecar requests.
    pub fn channel_token(&self) -> Zeroizing<String> {
        let mut token = Zeroizing::new(String::with_capacity(64));
        for byte in self.token.iter() {
            let _ = write!(token, "{byte:02x}");
        }
        token
    }

    pub fn stop(&mut self) -> io::Result<ExitStatus> {
        self.control.take();
        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                self.child.kill()?;
                return self.child.wait();
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests;
