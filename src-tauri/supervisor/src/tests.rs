use std::{
    env,
    io::{self, BufRead, BufReader, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use super::{Sidecar, lock_instance};

fn stage() -> PathBuf {
    env::var_os("FACTORY_TEST_WINDOWS_STAGE")
        .expect("Set FACTORY_TEST_WINDOWS_STAGE")
        .into()
}

fn status(port: u16, native_token: Option<&str>) -> u16 {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut pipe = TcpStream::connect_timeout(&address.into(), Duration::from_secs(2)).unwrap();
    pipe.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(
        pipe,
        "GET /healthz HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n"
    )
    .unwrap();
    if let Some(token) = native_token {
        write!(pipe, "X-Factory-Desktop-Channel: {token}\r\n").unwrap();
    }
    write!(pipe, "\r\n").unwrap();
    let mut line = String::new();
    BufReader::new(pipe).read_line(&mut line).unwrap();
    line.split_whitespace().nth(1).unwrap().parse().unwrap()
}

#[test]
fn excludes_another_launcher_for_the_same_data_directory() {
    let data = tempfile::tempdir().unwrap();
    let owner = lock_instance(data.path()).unwrap();
    assert_eq!(
        lock_instance(data.path()).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(owner);
    assert!(lock_instance(data.path()).is_ok());
}

#[test]
#[ignore = "requires a Windows staging directory with the packaged Node runtime"]
fn starts_and_stops_the_packaged_child_and_reopens_the_same_vault() {
    let stage = stage();
    let data = tempfile::tempdir().unwrap();
    let mut child = Sidecar::start(&stage, data.path(), None).unwrap();
    assert!(child.port() > 0);
    assert_eq!(status(child.port(), None), 404);
    assert_eq!(
        status(child.port(), Some(child.channel_token().as_str())),
        200
    );
    assert_eq!(
        Sidecar::start(&stage, data.path(), None)
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    assert!(child.stop().unwrap().success());
    drop(child);
    let mut restarted = Sidecar::start(&stage, data.path(), None).unwrap();
    assert!(restarted.stop().unwrap().success());
}

#[test]
#[ignore = "requires a Windows staging directory with the packaged Node runtime"]
fn forced_supervisor_exit_closes_the_listener_and_releases_the_lock() {
    let data = tempfile::tempdir().unwrap();
    let mut fixture = Command::new(env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "tests::crash_fixture",
            "--nocapture",
        ])
        .env("FACTORY_TEST_CRASH_ROOT", data.path())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let port = BufReader::new(fixture.stdout.take().unwrap())
        .lines()
        .map_while(Result::ok)
        .find_map(|line| {
            line.strip_prefix("ready ")
                .and_then(|value| value.parse::<u16>().ok())
        })
        .expect("Crash fixture did not report readiness");
    assert_eq!(status(port, None), 404);
    fixture.kill().unwrap();
    fixture.wait().unwrap();
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let deadline = Instant::now() + Duration::from_secs(5);
    while TcpStream::connect_timeout(&address.into(), Duration::from_millis(100)).is_ok() {
        assert!(Instant::now() < deadline, "Node survived its supervisor");
        thread::sleep(Duration::from_millis(25));
    }
    let mut restarted = Sidecar::start(&stage(), data.path(), None).unwrap();
    assert!(restarted.stop().unwrap().success());
}

#[test]
#[ignore = "subprocess fixture for the forced supervisor exit test"]
fn crash_fixture() {
    let Some(data) = env::var_os("FACTORY_TEST_CRASH_ROOT") else {
        return;
    };
    let child = Sidecar::start(&stage(), Path::new(&data), None).unwrap();
    println!("ready {}", child.port());
    thread::sleep(Duration::from_secs(30));
}
