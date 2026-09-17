fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&atlas_theme::built_in_themes().unwrap()).unwrap()
    );
}
