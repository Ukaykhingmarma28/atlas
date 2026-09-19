fn main() {
    println!("{}", serde_json::to_string_pretty(&atlas_theme::json_schema()).unwrap());
}
