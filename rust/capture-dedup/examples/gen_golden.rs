//! Regenerate `golden/vectors.json`:
//!
//! ```sh
//! cargo run --example gen_golden > golden/vectors.json
//! ```

fn main() {
    print!("{}", capture_dedup::golden::render_golden_json());
}
