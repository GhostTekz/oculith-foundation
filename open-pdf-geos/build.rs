use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let libdir = find_libdir();
    println!("cargo:rerun-if-env-changed=GEOS_PREFIX");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    println!("cargo:rustc-link-search=native={}", libdir.display());
    println!("cargo:rustc-link-lib=dylib=geos_c");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", libdir.display());
    if cfg!(target_os = "linux") {
        // DT_RPATH, so libgeos_c can load libgeos from this same directory.
        println!("cargo:rustc-link-arg=-Wl,--disable-new-dtags");
    }
}

fn find_libdir() -> PathBuf {
    if let Ok(prefix) = std::env::var("GEOS_PREFIX") {
        for relative in ["lib", "usr/lib"] {
            let dir = Path::new(&prefix).join(relative);
            if has_geos_c(&dir) {
                return dir;
            }
        }
        panic!("GEOS_PREFIX={prefix} has no libgeos_c shared library. See docs/developer/geos.md.");
    }
    if let Some(dir) = pkg_config_libdir() {
        return dir;
    }
    panic!(
        "libgeos_c was not found. Install GEOS 3.14.1 or set GEOS_PREFIX to the directory that contains lib/libgeos_c.so. See docs/developer/geos.md."
    );
}

fn has_geos_c(dir: &Path) -> bool {
    dir.join("libgeos_c.so").is_file() || dir.join("libgeos_c.dylib").is_file()
}

fn pkg_config_libdir() -> Option<PathBuf> {
    let output = Command::new("pkg-config")
        .args(["--libs-only-L", "geos"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    for token in text.split_whitespace() {
        let dir = PathBuf::from(token.strip_prefix("-L")?);
        if has_geos_c(&dir) {
            return Some(dir);
        }
    }
    None
}
