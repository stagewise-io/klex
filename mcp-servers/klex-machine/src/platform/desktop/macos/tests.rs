//! Runs against the real window server. What it can check depends on the
//! TCC grants of whatever started the test run; without them only the
//! hint is checked.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use super::provider;
use crate::desktop::provider::{
    CaptureOptions, DesktopCapabilities, DesktopProvider, ImageFormat, Point, Region, ScreenSize,
    ScrollDirection,
};

async fn probe() -> (Arc<dyn DesktopProvider>, DesktopCapabilities) {
    let provider = provider(Arc::new(|_: &str| {}));
    let capabilities = provider.probe().await;
    eprintln!("macOS desktop probe: {capabilities:?}");
    (provider, capabilities)
}

fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let word = |at: usize| u32::from_be_bytes(png[at..at + 4].try_into().unwrap());
    (word(16), word(20))
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_hint_whenever_computer_use_is_off() {
    let (_, capabilities) = probe().await;
    if capabilities.computer_use {
        let screen = capabilities.screen.expect("a screen with computer use");
        assert!(screen.width > 0 && screen.height > 0);
        assert!(capabilities.stream);
        assert_eq!(capabilities.hint, None);
    } else {
        let hint = capabilities.hint.expect("a hint without computer use");
        assert!(
            hint.contains("permission") || hint.contains("session"),
            "{hint}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn captures_the_screen_and_regions() {
    let (provider, capabilities) = probe().await;
    let Some(screen) = capabilities.screen else {
        return;
    };
    let full = provider
        .capture(CaptureOptions {
            region: None,
            size: Some(ScreenSize {
                width: 640,
                height: 400,
            }),
            format: ImageFormat::Png,
        })
        .await
        .unwrap();
    assert_eq!(png_size(&full), (640, 400));
    let region = provider
        .capture(CaptureOptions {
            region: Some(Region {
                x: screen.width / 4,
                y: screen.height / 4,
                width: 100,
                height: 60,
            }),
            size: None,
            format: ImageFormat::Png,
        })
        .await
        .unwrap();
    assert_eq!(png_size(&region), (100, 60));
    let jpeg = provider
        .capture(CaptureOptions {
            region: None,
            size: None,
            format: ImageFormat::Jpeg,
        })
        .await
        .unwrap();
    assert_eq!(&jpeg[..2], b"\xff\xd8");
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_input_and_lists_windows() {
    let (provider, capabilities) = probe().await;
    let Some(screen) = capabilities.screen else {
        return;
    };
    let center = Point {
        x: screen.width / 2,
        y: screen.height / 2,
    };
    provider.move_to(center).await.unwrap();
    provider
        .scroll(center, ScrollDirection::Down, 1)
        .await
        .unwrap();
    provider.key(vec!["shift".into()]).await.unwrap();
    for window in provider.list_windows().await.unwrap() {
        assert!(window.id.bytes().all(|byte| byte.is_ascii_digit()));
        assert!(window.bounds.width > 1 && window.bounds.height > 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_bad_arguments_like_node() {
    let (provider, _) = probe().await;
    let error = |result: Result<(), String>| result.unwrap_err();
    assert_eq!(
        error(provider.key(vec!["cmd+f21".into()]).await),
        "macOS has no F21 key; F1 to F20 work"
    );
    assert_eq!(
        error(provider.key(vec!["cmd+".into()]).await),
        "Invalid key combo: cmd+"
    );
    assert_eq!(
        error(provider.key(vec!["hyper+a".into()]).await),
        "Unsupported modifier: hyper"
    );
    assert_eq!(
        error(provider.focus_window("abc".into()).await),
        "Invalid window id: abc"
    );
}

async fn read(stream: &mut DuplexStream, count: usize) -> Vec<u8> {
    let mut buffer = vec![0; count];
    tokio::time::timeout(Duration::from_secs(20), stream.read_exact(&mut buffer))
        .await
        .expect("RFB bytes in time")
        .unwrap();
    buffer
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_the_screen_over_rfb() {
    let (provider, capabilities) = probe().await;
    if !capabilities.stream {
        assert!(provider.open_stream().await.is_err());
        return;
    }
    let mut stream = provider.open_stream().await.unwrap();
    assert_eq!(read(&mut stream, 12).await, b"RFB 003.008\n");
    stream.write_all(b"RFB 003.008\n").await.unwrap();
    let count = read(&mut stream, 1).await[0] as usize;
    assert!(read(&mut stream, count).await.contains(&1));
    stream.write_all(&[1]).await.unwrap();
    assert_eq!(read(&mut stream, 4).await, [0, 0, 0, 0]);
    stream.write_all(&[1]).await.unwrap();
    let init = read(&mut stream, 24).await;
    let width = u16::from_be_bytes([init[0], init[1]]);
    let height = u16::from_be_bytes([init[2], init[3]]);
    assert!(width > 0 && height > 0);
    let name = u32::from_be_bytes(init[20..24].try_into().unwrap()) as usize;
    read(&mut stream, name).await;
    stream.write_all(&[2, 0, 0, 1, 0, 0, 0, 0]).await.unwrap();
    let mut request = vec![3, 0, 0, 0, 0, 0];
    request.extend_from_slice(&width.to_be_bytes());
    request.extend_from_slice(&height.to_be_bytes());
    stream.write_all(&request).await.unwrap();
    loop {
        match read(&mut stream, 1).await[0] {
            0 => break,
            2 => {}
            3 => {
                let header = read(&mut stream, 7).await;
                let length = u32::from_be_bytes(header[3..7].try_into().unwrap());
                read(&mut stream, length as usize).await;
            }
            other => panic!("unexpected RFB message {other}"),
        }
    }
    let header = read(&mut stream, 3).await;
    assert!(u16::from_be_bytes([header[1], header[2]]) > 0);
}

#[test]
fn recognizes_app_bundles_by_name() {
    assert!(super::launch::is_bundle("Safari.app"));
    assert!(super::launch::is_bundle("/Applications/Calculator.APP/"));
    assert!(!super::launch::is_bundle("/bin/sleep"));
    assert!(!super::launch::is_bundle("编辑器"));
    assert!(!super::launch::is_bundle("é"));
}
