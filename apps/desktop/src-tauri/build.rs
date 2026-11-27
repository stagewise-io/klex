fn main() {
    println!("cargo::rustc-check-cfg=cfg(gui_subsystem)");
    println!("cargo::rerun-if-env-changed=KLEX_DESKTOP_GUI_SUBSYSTEM");
    if std::env::var_os("KLEX_DESKTOP_GUI_SUBSYSTEM").is_some() {
        println!("cargo::rustc-cfg=gui_subsystem");
    }
    tauri_build::build();
}
