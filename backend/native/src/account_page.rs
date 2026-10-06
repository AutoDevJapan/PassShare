//! Script-free account settings rendered by the existing native service.
use serde_json::{json, Value};

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn validate_form(input: &Value) -> Value {
    if input["confirmPassword"].as_str().is_none()
        || input["confirmPassword"] != input["newPassword"]
    {
        return json!({"status":400,"code":"PS047","message":"New passwords do not match"});
    }
    super::account::validate_input(input)
}

pub fn render(input: &Value) -> Value {
    let locale = match input["locale"].as_str() {
        Some("en") => "en",
        Some("ru") => "ru",
        _ => "ja",
    };
    let text = match locale {
        "en" => ["Account", "Password boxes", "Invitations", "Change account password",
            "Changing your password signs you out on every device.", "Current password", "New password",
            "Repeat new password", "Use at least 8 characters, up to 1024 bytes, different from your current password.",
            "Change and sign out", "Back to password boxes", "This is separate from the desktop master password.",
            "Password changed. Sign in again with your new password.", "Sign in", "Your session has expired. Sign in again.",
            "The new passwords do not match.", "Check your current password.", "Use a different new password.",
            "Check the password length.", "Too many attempts. Please try again later.",
            "This form has expired. Please enter your passwords again.", "Could not confirm the change. Try signing in with the new password before trying again."],
        "ru" => ["Аккаунт", "Парольные ящики", "Приглашения", "Изменить пароль аккаунта",
            "После изменения пароля сеансы на всех устройствах будут завершены.", "Текущий пароль", "Новый пароль",
            "Повторите новый пароль", "Не менее 8 символов, не более 1024 байт. Пароль должен отличаться от текущего.",
            "Изменить и выйти", "К парольным ящикам", "Это отдельная настройка, не мастер-пароль настольного приложения.",
            "Пароль изменён. Войдите снова с новым паролем.", "Войти", "Сеанс истёк. Войдите снова.",
            "Новые пароли не совпадают.", "Проверьте текущий пароль.", "Используйте другой новый пароль.",
            "Проверьте длину пароля.", "Слишком много попыток. Попробуйте позже.",
            "Форма устарела. Введите пароли снова.", "Не удалось подтвердить изменение. Перед повторной попыткой попробуйте войти с новым паролем."],
        _ => ["アカウント", "パスワードボックス", "招待", "アカウントのパスワード変更",
            "変更すると、すべての端末からログアウトします。", "現在のパスワード", "新しいパスワード",
            "新しいパスワードをもう一度", "8文字以上・1024バイト以下で、今のパスワードと異なるものを設定してください。",
            "変更してログアウト", "パスワードボックスへ戻る", "端末版のマスターパスワードとは別の設定です。",
            "パスワードを変更しました。新しいパスワードで再ログインしてください。", "ログインする", "ログインの期限が切れました。再ログインしてください。",
            "新しいパスワードが一致しません。", "現在のパスワードを確認してください。", "今とは異なる新しいパスワードを設定してください。",
            "パスワードの長さを確認してください。", "試行回数が多すぎます。時間をおいて試してください。",
            "画面の期限が切れました。パスワードを入力し直してください。", "変更できたか確認できません。再試行の前に、新しいパスワードでログインできるか確認してください。"],
    };
    let web = escape(input["webOrigin"].as_str().unwrap_or(""));
    let csrf = escape(input["csrfToken"].as_str().unwrap_or(""));
    let success = input["success"] == true;
    let code = input["errorCode"].as_str().unwrap_or("");
    let expired = matches!(code, "PS024" | "PS025" | "PS022");
    let message = match code {
        "" => "",
        "PS024" | "PS025" | "PS022" => text[14],
        "PS047" => text[15],
        "PS026" => text[16],
        "PS046" => text[17],
        "PS021" => text[18],
        "PS028" | "PS029" => text[19],
        "PS027" => text[20],
        _ => text[21],
    };
    let title = text[3];
    let mut html = format!(
        r#"<!doctype html><html lang="{locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} | PassShare</title><style>{STYLE}</style></head><body>
<header><a class="brand" href="{web}/app/vaults">PassShare</a><nav aria-label="PassShare"><a href="{web}/app/vaults">{}</a><a href="{web}/app/invitations">{}</a><span aria-current="page">{}</span></nav></header><main><h1>{title}</h1>"#,
        text[1], text[2], text[0]
    );
    if success || expired {
        let status = if success { text[12] } else { text[14] };
        html.push_str(&format!(
            r#"<p role="status">{status}</p><a class="button" href="{web}/app/login">{}</a>"#,
            text[13]
        ));
    } else {
        html.push_str(&format!("<p>{}</p>", text[4]));
        if !message.is_empty() {
            html.push_str(&format!(r#"<p class="error" role="alert">{message}</p>"#));
        }
        html.push_str(&format!(r#"<form method="post" action="/api/auth/password/settings">
<input type="hidden" name="csrfToken" value="{csrf}"><input type="hidden" name="locale" value="{locale}"><input type="hidden" name="webOrigin" value="{web}">
<label for="current">{}</label><input id="current" name="currentPassword" type="password" autocomplete="current-password" required>
<label for="new">{}</label><input id="new" name="newPassword" type="password" autocomplete="new-password" required aria-describedby="hint">
<label for="confirm">{}</label><input id="confirm" name="confirmPassword" type="password" autocomplete="new-password" required aria-describedby="hint">
<p id="hint">{}</p><button type="submit">{}</button></form><a class="back" href="{web}/app/vaults">{}</a>"#, text[5], text[6], text[7], text[8], text[9], text[10]));
    }
    html.push_str(&format!(
        "<footer>{}</footer></main></body></html>",
        text[11]
    ));
    json!({"status":200,"body":html})
}

const STYLE: &str = r#"
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0d151f;color:#f4f7fb}*{box-sizing:border-box}body{margin:0}a{color:#91edce;text-decoration:none}header{padding:24px 6vw;border-bottom:1px solid #29394a;display:flex;align-items:center;gap:60px}nav{display:flex;gap:36px;flex-wrap:wrap;align-items:center}nav a{color:#bbc8d8}nav span{color:#91edce;border-bottom:3px solid #91edce;padding:12px 0}.brand{color:#f4f7fb;font-size:28px;font-weight:700}main{width:min(100% - 40px,680px);margin:48px auto}h1{font-size:28px;line-height:1.5;margin:0 0 12px}p{color:#bbc8d8;line-height:1.7}label{display:block;margin:24px 0 8px}input[type=password]{width:100%;border:1px solid #46596c;background:#1d2b3a;color:#f4f7fb;border-radius:8px;padding:14px;font:inherit}input:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid #91edce;outline-offset:3px}button,.button{display:block;width:100%;margin:32px 0 24px;border:0;border-radius:8px;padding:16px;background:#91edce;color:#071a19;font:inherit;font-size:18px;font-weight:700;text-align:center;cursor:pointer}.back{display:block;text-align:center}footer{border-top:1px solid #29394a;margin-top:28px;padding-top:24px;color:#bbc8d8;text-align:center;font-size:14px}.error{color:#ffd2cc;border-left:3px solid #ef9c91;padding:12px}#hint{font-size:14px}@media(max-width:600px){header{padding:18px 20px;gap:12px;flex-direction:column;align-items:flex-start}nav{gap:24px;font-size:14px}main{margin:28px auto}h1{font-size:23px}}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmation_is_required_and_compared_exactly() {
        let mut input =
            json!({"currentPassword":"Synthetic-current!","newPassword":"Synthetic-next!"});
        for value in [
            Value::Null,
            json!(["Synthetic-next!"]),
            json!("Synthetic-next! "),
        ] {
            input["confirmPassword"] = value;
            assert_eq!(validate_form(&input)["code"], "PS047");
        }
        input["confirmPassword"] = input["newPassword"].clone();
        assert_eq!(validate_form(&input)["status"], 200);
        input["newPassword"] = input["currentPassword"].clone();
        input["confirmPassword"] = input["newPassword"].clone();
        assert_eq!(validate_form(&input)["code"], "PS046");
    }
    #[test]
    fn escaped_context_never_echoes_passwords_or_arbitrary_errors() {
        let page = render(
            &json!({"locale":"ja","csrfToken":"\"><script>","webOrigin":"\" onload=\"evil", "errorCode":"<script>","currentPassword":"Synthetic-do-not-render!"}),
        );
        let html = page["body"].as_str().unwrap();
        assert!(!html.contains("<script>"));
        assert!(!html.contains("Synthetic-do-not-render!"));
        assert!(html.contains("&quot;&gt;&lt;script&gt;"));
        assert!(html.contains("変更できたか確認できません"));
    }
    #[test]
    fn success_and_expiration_only_offer_reauthentication() {
        for input in [
            json!({"success":true}),
            json!({"errorCode":"PS024"}),
            json!({"errorCode":"PS025"}),
        ] {
            let page = render(&input);
            let html = page["body"].as_str().unwrap();
            assert!(!html.contains("<form"));
            assert!(html.contains("/app/login"));
        }
    }
}
