use super::super::pipewire::Frame;
use super::super::portal::{Connector, Ended, Established, WAITING_HINT};
use super::*;
use crate::desktop::provider::ImageFormat;

struct FakeRemote {
    frame: Frame,
    inputs: Mutex<Vec<Input>>,
    refuse: Option<Input>,
}

impl Remote for FakeRemote {
    fn latest(&self) -> Option<Frame> {
        Some(self.frame.clone())
    }
    fn wait_newer(&self, after: u64, _: Duration) -> Result<Option<Frame>, String> {
        Ok((self.frame.sequence > after).then(|| self.frame.clone()))
    }
    fn input(&self, input: Input) -> BoxFuture<'_, Result<(), String>> {
        self.inputs.lock().unwrap().push(input);
        let refused = self.refuse == Some(input);
        futures::future::ready(if refused {
            Err("refused".into())
        } else {
            Ok(())
        })
        .boxed()
    }
    fn ended(&self) -> Option<Ended> {
        None
    }
}

/// A 4x2 frame whose pixel at (x, y) is BGRX (x, y, 7, 0).
fn frame() -> Frame {
    let mut bgrx = Vec::new();
    for y in 0..2u8 {
        for x in 0..4u8 {
            bgrx.extend_from_slice(&[x, y, 7, 0]);
        }
    }
    Frame {
        width: 4,
        height: 2,
        bgrx: Arc::new(bgrx),
        sequence: 1,
    }
}

async fn ready(refuse: Option<Input>) -> (WaylandDesktopProvider, Arc<FakeRemote>) {
    let remote = Arc::new(FakeRemote {
        frame: frame(),
        inputs: Mutex::default(),
        refuse,
    });
    let shared = remote.clone();
    let connect: Connector = Arc::new(move |_| {
        let remote = shared.clone() as Arc<dyn Remote>;
        futures::future::ready(Ok(Established {
            remote,
            token: None,
        }))
        .boxed()
    });
    let provider = WaylandDesktopProvider::new(
        Portal::new(None, connect, Arc::new(|_: &str| {})),
        Some(":0".into()),
        Arc::new(|_: &str| {}),
    );
    assert_eq!(
        provider.probe().await,
        DesktopCapabilities::unavailable(WAITING_HINT)
    );
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    (provider, remote)
}

fn taken(remote: &FakeRemote) -> Vec<Input> {
    std::mem::take(&mut *remote.inputs.lock().unwrap())
}

#[tokio::test]
async fn reports_the_frame_size_once_sharing_is_allowed() {
    let (provider, _) = ready(None).await;
    let capabilities = provider.probe().await;
    assert!(capabilities.computer_use && capabilities.stream);
    assert!(!capabilities.accessibility);
    assert_eq!(
        capabilities.screen,
        Some(ScreenSize {
            width: 4,
            height: 2
        })
    );
    assert_eq!(
        provider.list_windows().await.unwrap_err(),
        NO_WINDOWS.to_string()
    );
}

#[tokio::test]
async fn crops_screenshots_from_the_latest_frame() {
    let (provider, _) = ready(None).await;
    let png = provider
        .capture(CaptureOptions {
            region: Some(Region {
                x: 2,
                y: 1,
                width: 10,
                height: 10,
            }),
            size: None,
            format: ImageFormat::Png,
        })
        .await
        .unwrap();
    let image = image::load_from_memory(&png).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (2, 1));
    assert_eq!(image.get_pixel(0, 0).0, [7, 1, 2]);
    assert_eq!(image.get_pixel(1, 0).0, [7, 1, 3]);
}

#[tokio::test]
async fn clicks_with_modifiers_and_releases_them_after_a_failure() {
    let (provider, remote) = ready(None).await;
    provider
        .click(
            Point { x: 3, y: 1 },
            MouseButton::Right,
            2,
            vec!["ctrl".into()],
        )
        .await
        .unwrap();
    let control = keys::keysym("ctrl").unwrap();
    assert_eq!(
        taken(&remote),
        [
            Input::Keysym(control, true),
            Input::Motion(3.0, 1.0),
            Input::Button(BTN_RIGHT, true),
            Input::Button(BTN_RIGHT, false),
            Input::Button(BTN_RIGHT, true),
            Input::Button(BTN_RIGHT, false),
            Input::Keysym(control, false),
        ]
    );

    let (provider, remote) = ready(Some(Input::Button(BTN_LEFT, true))).await;
    assert!(
        provider
            .click(
                Point { x: 0, y: 0 },
                MouseButton::Left,
                1,
                vec!["shift".into()]
            )
            .await
            .is_err()
    );
    let shift = keys::keysym("shift").unwrap();
    assert_eq!(taken(&remote).last(), Some(&Input::Keysym(shift, false)));
}

#[tokio::test]
async fn types_keys_and_scrolls_through_keysyms_and_axis_steps() {
    let (provider, remote) = ready(None).await;
    provider.type_text("aB".into()).await.unwrap();
    provider.key(vec!["ctrl+shift+t".into()]).await.unwrap();
    provider
        .scroll(Point { x: 1, y: 1 }, ScrollDirection::Up, 2)
        .await
        .unwrap();
    let (control, shift, t) = (
        keys::keysym("ctrl").unwrap(),
        keys::keysym("shift").unwrap(),
        keys::keysym("t").unwrap(),
    );
    assert_eq!(
        taken(&remote),
        [
            Input::Keysym(0x61, true),
            Input::Keysym(0x61, false),
            Input::Keysym(0x42, true),
            Input::Keysym(0x42, false),
            Input::Keysym(control, true),
            Input::Keysym(shift, true),
            Input::Keysym(t, true),
            Input::Keysym(t, false),
            Input::Keysym(shift, false),
            Input::Keysym(control, false),
            Input::Motion(1.0, 1.0),
            Input::Axis {
                vertical: true,
                steps: -1
            },
            Input::Axis {
                vertical: true,
                steps: -1
            },
        ]
    );
}

#[test]
fn maps_viewer_keys_to_evdev_codes_or_keysyms() {
    let key = |keycode, keysym| StreamKey {
        down: true,
        keysym,
        keycode,
    };
    assert_eq!(stream_key(key(0x1e, 0x61)), Some(Input::Keycode(30, true)));
    assert_eq!(
        stream_key(key(0xc8, 0xff52)),
        Some(Input::Keycode(103, true))
    );
    assert_eq!(
        stream_key(key(0xdb, 0xffeb)),
        Some(Input::Keycode(125, true))
    );
    assert_eq!(
        stream_key(key(0, 0x20ac)),
        Some(Input::Keysym(0x20ac, true))
    );
    assert_eq!(stream_key(key(0xf0, 0)), None);
}

#[tokio::test]
async fn releases_held_stream_input_when_the_viewer_leaves() {
    let (_, remote) = ready(None).await;
    let (sender, receiver) = unbounded_channel();
    let task = tokio::spawn(input_loop(remote.clone(), Arc::new(|_: &str| {}), receiver));
    sender
        .send(StreamInput::Button(MouseButton::Left, true, 2, 1))
        .unwrap();
    sender
        .send(StreamInput::Key(StreamKey {
            down: true,
            keysym: 0xffe1,
            keycode: 0x2a,
        }))
        .unwrap();
    drop(sender);
    task.await.unwrap();
    assert_eq!(
        taken(&remote),
        [
            Input::Motion(2.0, 1.0),
            Input::Button(BTN_LEFT, true),
            Input::Keycode(42, true),
            Input::Keycode(42, false),
            Input::Button(BTN_LEFT, false),
        ]
    );
}
