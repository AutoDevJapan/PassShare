/// Desktop/Tauri-facing login item view (Connect ID as string).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginItemView {
    pub id: String,
    pub title: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub notes: String,
}
