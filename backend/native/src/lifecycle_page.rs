//! Script-free recovery key, account recovery and retirement pages.
//!
//! The renderer never receives a password or recovery key. Output slots are
//! whole `value="<marker>"` attributes: a quote in user data is always escaped,
//! so no email or box name can imitate a slot. The service substitutes only a
//! server generated token that already passed its own validation.
use super::account_page::{escape, STYLE};
use super::retirement::needs_transfer;
use serde_json::{json, Value};

pub const CSRF_SLOT: &str = r#"value="@@PASSSHARE-CSRF-SLOT-7c1d@@""#;
pub const KEY_SLOT: &str = r#"value="@@PASSSHARE-KEY-SLOT-b94e@@""#;
const MAX_BOXES: usize = 20;
const MAX_CANDIDATES: usize = 100;

#[derive(Clone, Copy, PartialEq)]
enum Page {
    Key,
    Recover,
    Retire,
}

struct T {
    boxes: &'static str,
    invitations: &'static str,
    account: &'static str,
    hub: &'static str,
    login: &'static str,
    home: &'static str,
    footer: &'static str,
    current: &'static str,
    key_title: &'static str,
    key_lead: &'static str,
    key_issue: &'static str,
    key_label: &'static str,
    key_ready: &'static str,
    key_once: &'static str,
    key_reissue: &'static str,
    key_password: &'static str,
    rec_title: &'static str,
    rec_email: &'static str,
    rec_key: &'static str,
    rec_new: &'static str,
    rec_again: &'static str,
    rec_hint: &'static str,
    rec_button: &'static str,
    rec_logout: &'static str,
    rec_done: &'static str,
    ret_title: &'static str,
    ret_lead: &'static str,
    ret_target: &'static str,
    ret_transfer: &'static str,
    ret_confirm: &'static str,
    ret_private: &'static str,
    ret_shared: &'static str,
    ret_delete: &'static str,
    ret_unnamed: &'static str,
    ret_pending: &'static str,
    ret_manage: &'static str,
    ret_join: &'static str,
    ret_more: &'static str,
    ret_transferred: &'static str,
    ret_continue: &'static str,
    ret_deleted: &'static str,
    e_expired: &'static str,
    e_mismatch: &'static str,
    e_current: &'static str,
    e_throttle: &'static str,
    e_form: &'static str,
    e_key: &'static str,
    e_invalid: &'static str,
    e_recover: &'static str,
    e_length: &'static str,
    e_email: &'static str,
    e_confirm: &'static str,
    e_first: &'static str,
    e_target: &'static str,
    e_owner: &'static str,
    e_retire: &'static str,
}

static JA: T = T {
    boxes: "パスワードボックス",
    invitations: "招待",
    account: "アカウント",
    hub: "アカウント設定へ戻る",
    login: "ログインする",
    home: "トップへ戻る",
    footer: "ここでの復旧は、アカウントへのログインだけです。端末内の暗号化ファイルや暗号鍵の復旧とは別です。",
    current: "現在のパスワード",
    key_title: "復旧キーを保管する",
    key_lead: "パスワードを忘れたときに、アカウントへ戻るためのキーです。",
    key_issue: "復旧キーを発行",
    key_label: "復旧キー",
    key_ready: "復旧キーを発行しました。この画面を離れると、もう一度は表示できません。",
    key_once: "表示は一度だけです。オフラインで控えてください。",
    key_reissue: "再発行すると、以前のキーは使えなくなります。",
    key_password: "パスワード変更だけでは、キーは無効になりません。",
    rec_title: "アカウントを復旧する",
    rec_email: "メールアドレス",
    rec_key: "復旧キー",
    rec_new: "新しいパスワード",
    rec_again: "新しいパスワードをもう一度",
    rec_hint: "新しいパスワードは8文字以上、1024バイト以下にしてください。",
    rec_button: "復旧してログインへ",
    rec_logout: "復旧すると、すべての端末からログアウトします。",
    rec_done: "パスワードを復旧しました。すべての端末からログアウトしました。新しいパスワードでログインし、復旧キーを再発行してください。",
    ret_title: "共有を引き継いで退会する",
    ret_lead: "共有の最後の所有者は、先に所有者を移譲します。",
    ret_target: "引き継ぐ相手",
    ret_transfer: "所有者を移譲",
    ret_confirm: "確認用メールアドレス",
    ret_private: "本人だけのパスワードボックスは削除します。",
    ret_shared: "ほかの人が使う共有データは残します。",
    ret_delete: "アカウントを削除",
    ret_unnamed: "名前のないパスワードボックス",
    ret_pending: "本人確認が済んだメンバーがいないため、まだ移譲できません。",
    ret_manage: "メンバーを確認・除名する",
    ret_join: "相手は「招待」で確認コードを入力して参加を完了できます。",
    ret_more: "ほかにも共有ボックスがあります。移譲したあとにこの画面を開き直すと表示されます。",
    ret_transferred: "所有者を移譲しました。",
    ret_continue: "続けて確認する",
    ret_deleted: "アカウントを削除しました。ご利用ありがとうございました。",
    e_expired: "ログインの期限が切れました。再ログインしてください。",
    e_mismatch: "新しいパスワードが一致しません。",
    e_current: "現在のパスワードを確認してください。",
    e_throttle: "試行回数が多すぎます。時間をおいて試してください。",
    e_form: "画面の期限が切れました。もう一度入力してください。",
    e_key: "復旧キーを発行できませんでした。時間をおいて、もう一度お試しください。",
    e_invalid: "メールアドレスまたは復旧キーが正しくありません。",
    e_recover: "復旧できたか確認できません。新しいパスワードでログインできるか確認してから、もう一度お試しください。",
    e_length: "新しいパスワードの長さを確認してください。",
    e_email: "メールアドレスの形式を確認してください。",
    e_confirm: "確認用メールアドレスが、登録のメールアドレスと一致しません。",
    e_first: "共有の最後の所有者です。先に所有者を移譲してから、もう一度お試しください。",
    e_target: "引き継ぐ相手を、本人確認が済んだメンバーから選んでください。",
    e_owner: "この操作は所有者だけができます。",
    e_retire: "操作できたか確認できません。この画面を開き直して、状態を確認してください。",
};

static EN: T = T {
    boxes: "Password boxes",
    invitations: "Invitations",
    account: "Account",
    hub: "Back to account settings",
    login: "Sign in",
    home: "Back to home",
    footer: "Recovery here only gets you back into your account. It is separate from recovering encrypted files or encryption keys on a device.",
    current: "Current password",
    key_title: "Keep your recovery key",
    key_lead: "Use this key to get back into your account if you forget your password.",
    key_issue: "Issue recovery key",
    key_label: "Recovery key",
    key_ready: "Your recovery key is ready. It cannot be shown again after you leave this page.",
    key_once: "It is shown only once. Save it offline.",
    key_reissue: "Issuing a new key stops the previous key from working.",
    key_password: "Changing your password does not turn the key off.",
    rec_title: "Recover your account",
    rec_email: "Email address",
    rec_key: "Recovery key",
    rec_new: "New password",
    rec_again: "Repeat new password",
    rec_hint: "Use at least 8 characters, up to 1024 bytes.",
    rec_button: "Recover and go to sign in",
    rec_logout: "Recovering signs you out on every device.",
    rec_done: "Your account is recovered and signed out everywhere. Sign in with your new password, then issue a new recovery key.",
    ret_title: "Hand over sharing and leave",
    ret_lead: "If you are the last owner of a shared box, hand over ownership first.",
    ret_target: "Hand over to",
    ret_transfer: "Transfer ownership",
    ret_confirm: "Confirm with your email address",
    ret_private: "Password boxes only you use will be deleted.",
    ret_shared: "Shared data that other people use stays.",
    ret_delete: "Delete account",
    ret_unnamed: "Unnamed password box",
    ret_pending: "No member has finished identity confirmation, so ownership cannot move yet.",
    ret_manage: "Review or remove members",
    ret_join: "The member can finish joining by entering the confirmation code under Invitations.",
    ret_more: "You have more shared boxes. Reopen this page after transferring to see them.",
    ret_transferred: "Ownership transferred.",
    ret_continue: "Continue",
    ret_deleted: "Your account has been deleted. Thank you for using PassShare.",
    e_expired: "Your session has expired. Sign in again.",
    e_mismatch: "The new passwords do not match.",
    e_current: "Check your current password.",
    e_throttle: "Too many attempts. Please try again later.",
    e_form: "This form has expired. Please enter your details again.",
    e_key: "Could not issue a recovery key. Wait a moment and try again.",
    e_invalid: "The email address or recovery key is not correct.",
    e_recover: "Could not confirm the recovery. Try signing in with the new password before trying again.",
    e_length: "Check the length of the new password.",
    e_email: "Check the email address format.",
    e_confirm: "The confirmation email does not match your account email.",
    e_first: "You are the last owner of a shared box. Transfer ownership first, then try again.",
    e_target: "Choose a member who has finished identity confirmation.",
    e_owner: "Only an owner can do this.",
    e_retire: "Could not confirm the operation. Reopen this page and check the current state.",
};

static RU: T = T {
    boxes: "Парольные ящики",
    invitations: "Приглашения",
    account: "Аккаунт",
    hub: "К настройкам аккаунта",
    login: "Войти",
    home: "На главную",
    footer: "Восстановление здесь только возвращает вход в аккаунт. Оно не восстанавливает зашифрованные файлы и ключи шифрования на устройстве.",
    current: "Текущий пароль",
    key_title: "Сохраните ключ восстановления",
    key_lead: "Этим ключом можно вернуться в аккаунт, если вы забыли пароль.",
    key_issue: "Выпустить ключ восстановления",
    key_label: "Ключ восстановления",
    key_ready: "Ключ восстановления готов. После ухода с этой страницы показать его снова нельзя.",
    key_once: "Ключ показывается только один раз. Сохраните его офлайн.",
    key_reissue: "Новый ключ отключает предыдущий.",
    key_password: "Смена пароля не отключает ключ.",
    rec_title: "Восстановление аккаунта",
    rec_email: "Адрес эл. почты",
    rec_key: "Ключ восстановления",
    rec_new: "Новый пароль",
    rec_again: "Повторите новый пароль",
    rec_hint: "Не менее 8 символов, не более 1024 байт.",
    rec_button: "Восстановить и перейти ко входу",
    rec_logout: "После восстановления вы выйдете на всех устройствах.",
    rec_done: "Аккаунт восстановлен, выход выполнен на всех устройствах. Войдите с новым паролем и выпустите новый ключ восстановления.",
    ret_title: "Передать общий доступ и выйти",
    ret_lead: "Если вы последний владелец общего ящика, сначала передайте владение.",
    ret_target: "Кому передать",
    ret_transfer: "Передать владение",
    ret_confirm: "Подтвердите адресом эл. почты",
    ret_private: "Парольные ящики, которыми пользуетесь только вы, будут удалены.",
    ret_shared: "Общие данные, которыми пользуются другие, останутся.",
    ret_delete: "Удалить аккаунт",
    ret_unnamed: "Парольный ящик без названия",
    ret_pending: "Ни один участник ещё не подтвердил личность, поэтому владение пока передать нельзя.",
    ret_manage: "Проверить или удалить участников",
    ret_join: "Участник может завершить присоединение, введя код подтверждения в разделе «Приглашения».",
    ret_more: "Есть и другие общие ящики. Откройте страницу снова после передачи, чтобы увидеть их.",
    ret_transferred: "Владение передано.",
    ret_continue: "Продолжить",
    ret_deleted: "Аккаунт удалён. Спасибо, что пользовались PassShare.",
    e_expired: "Сеанс истёк. Войдите снова.",
    e_mismatch: "Новые пароли не совпадают.",
    e_current: "Проверьте текущий пароль.",
    e_throttle: "Слишком много попыток. Попробуйте позже.",
    e_form: "Форма устарела. Введите данные снова.",
    e_key: "Не удалось выпустить ключ. Подождите и попробуйте снова.",
    e_invalid: "Адрес эл. почты или ключ восстановления указаны неверно.",
    e_recover: "Не удалось подтвердить восстановление. Перед повторной попыткой попробуйте войти с новым паролем.",
    e_length: "Проверьте длину нового пароля.",
    e_email: "Проверьте формат адреса эл. почты.",
    e_confirm: "Адрес для подтверждения не совпадает с адресом аккаунта.",
    e_first: "Вы последний владелец общего ящика. Сначала передайте владение и повторите попытку.",
    e_target: "Выберите участника, подтвердившего личность.",
    e_owner: "Это может сделать только владелец.",
    e_retire: "Не удалось подтвердить операцию. Откройте страницу снова и проверьте состояние.",
};

fn error(status: u16, code: &str, message: &str) -> Value {
    json!({"status":status,"code":code,"message":message})
}

fn valid_box_id(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn valid_user_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn message(t: &T, page: Page, code: &str) -> &'static str {
    match (page, code) {
        (_, "") => "",
        (_, "PS027") => t.e_form,
        (_, "PS028" | "PS029") => t.e_throttle,
        (Page::Recover, "PS026") => t.e_invalid,
        (Page::Recover, "PS047") => t.e_mismatch,
        (Page::Recover, "PS021") => t.e_length,
        (Page::Recover, "PS020") => t.e_email,
        (Page::Recover, _) => t.e_recover,
        (Page::Key, "PS026" | "PS021") => t.e_current,
        (Page::Key, _) => t.e_key,
        (Page::Retire, "PS026" | "PS021") => t.e_current,
        (Page::Retire, "PS047") => t.e_target,
        (Page::Retire, "PS032") => t.e_owner,
        (Page::Retire, "PS048") => t.e_confirm,
        (Page::Retire, "PS049") => t.e_first,
        (Page::Retire, _) => t.e_retire,
    }
}

struct Shared<'a> {
    t: &'a T,
    locale: &'a str,
}

impl Shared<'_> {
    fn hub(&self) -> String {
        // Relative on purpose: the API may be served behind a proxy prefix
        // (/backend/prd/api/...) that an absolute path would leave.
        format!("../password/settings?locale={}", self.locale)
    }
    fn hidden(&self) -> String {
        format!(
            r#"<input type="hidden" name="csrfToken" {CSRF_SLOT}><input type="hidden" name="locale" value="{}">"#,
            self.locale
        )
    }
    fn expired(&self) -> String {
        format!(
            r#"<p role="status">{}</p><a class="button" href="/app/login">{}</a>"#,
            self.t.e_expired, self.t.login
        )
    }
    fn alert(&self, text: &str) -> String {
        if text.is_empty() {
            String::new()
        } else {
            format!(r#"<p class="error" role="alert">{text}</p>"#)
        }
    }
    fn password_field(&self) -> String {
        format!(
            r#"<label for="current">{}</label><input id="current" name="currentPassword" type="password" autocomplete="current-password" required>"#,
            self.t.current
        )
    }
}

fn key_page(s: &Shared, state: &str, note: &str) -> String {
    let t = s.t;
    let notes = format!(
        r#"<ul class="notes"><li>{}</li><li>{}</li><li>{}</li></ul>"#,
        t.key_once, t.key_reissue, t.key_password
    );
    let back = format!(r#"<a class="back" href="{}">{}</a>"#, s.hub(), t.hub);
    match state {
        "issued" => format!(
            r#"<h1>{}</h1><p>{}</p><p role="status" class="ok">{}</p><label for="key">{}</label><input id="key" class="key" type="text" readonly spellcheck="false" autocomplete="off" {KEY_SLOT}><hr>{notes}{back}"#,
            t.key_title, t.key_lead, t.key_ready, t.key_label
        ),
        "expired" => format!("<h1>{}</h1>{}", t.key_title, s.expired()),
        _ => format!(
            r#"<h1>{}</h1><p>{}</p>{}<form method="post">{}{}<button type="submit">{}</button></form><hr>{notes}{back}"#,
            t.key_title,
            t.key_lead,
            s.alert(note),
            s.hidden(),
            s.password_field(),
            t.key_issue
        ),
    }
}

fn recover_page(s: &Shared, state: &str, note: &str) -> String {
    let t = s.t;
    if state == "done" {
        return format!(
            r#"<h1>{}</h1><p role="status" class="ok">{}</p><a class="button" href="/app/login">{}</a>"#,
            t.rec_title, t.rec_done, t.login
        );
    }
    format!(
        r#"<h1>{}</h1>{}<form method="post">{}
<label for="email">{}</label><input id="email" name="email" type="email" autocomplete="email" required>
<label for="key">{}</label><input id="key" name="recoveryKey" type="password" autocomplete="off" spellcheck="false" required>
<label for="new">{}</label><input id="new" name="newPassword" type="password" autocomplete="new-password" required aria-describedby="hint">
<label for="again">{}</label><input id="again" name="confirmPassword" type="password" autocomplete="new-password" required aria-describedby="hint">
<p id="hint">{}</p><button type="submit">{}</button></form><p>{}</p>"#,
        t.rec_title,
        s.alert(note),
        s.hidden(),
        t.rec_email,
        t.rec_key,
        t.rec_new,
        t.rec_again,
        t.rec_hint,
        t.rec_button,
        t.rec_logout
    )
}

struct Candidate<'a> {
    id: &'a str,
    email: &'a str,
}

struct SharedBox<'a> {
    id: &'a str,
    name: &'a str,
    candidates: Vec<Candidate<'a>>,
}

fn collect_boxes<'a>(input: &'a Value) -> Result<(Vec<SharedBox<'a>>, bool), Value> {
    let invalid = || error(400, "PS018", "Invalid page data");
    let actor = input["userId"].as_str().filter(|v| valid_user_id(v));
    let (Some(actor), Some(boxes)) = (actor, input["boxes"].as_array()) else {
        return Err(invalid());
    };
    let mut result = Vec::new();
    let mut more = false;
    for item in boxes {
        let id = item["id"]
            .as_str()
            .filter(|v| valid_box_id(v))
            .ok_or_else(invalid)?;
        let members = item["members"].as_array().ok_or_else(invalid)?;
        if members.len() > 1000 {
            return Err(invalid());
        }
        for m in members {
            m["user_id"]
                .as_str()
                .filter(|v| valid_user_id(v))
                .ok_or_else(invalid)?;
        }
        if !needs_transfer(actor, members) {
            continue;
        }
        if result.len() == MAX_BOXES {
            more = true;
            continue;
        }
        let mut candidates = Vec::new();
        for m in members {
            let eligible =
                m["user_id"] != actor && m["role"] == "member" && m["identity_confirmed"] == true;
            if eligible && candidates.len() < MAX_CANDIDATES {
                candidates.push(Candidate {
                    id: m["user_id"].as_str().unwrap_or(""),
                    email: m["email"].as_str().unwrap_or(""),
                });
            }
        }
        result.push(SharedBox {
            id,
            name: item["name"].as_str().unwrap_or("").trim(),
            candidates,
        });
    }
    Ok((result, more || input["more"] == true))
}

fn retire_page(s: &Shared, input: &Value, state: &str, note: &str) -> Result<String, Value> {
    let t = s.t;
    match state {
        "transferred" => {
            return Ok(format!(
                r#"<h1>{}</h1><p role="status" class="ok">{}</p><a class="button" href="retire?locale={}">{}</a><a class="back" href="{}">{}</a>"#,
                t.ret_title,
                t.ret_transferred,
                s.locale,
                t.ret_continue,
                s.hub(),
                t.hub
            ))
        }
        "deleted" => {
            return Ok(format!(
                r#"<h1>{}</h1><p role="status" class="ok">{}</p><a class="button" href="/">{}</a>"#,
                t.ret_title, t.ret_deleted, t.home
            ))
        }
        "expired" => return Ok(format!("<h1>{}</h1>{}", t.ret_title, s.expired())),
        _ => {}
    }
    let (boxes, more) = collect_boxes(input)?;
    let mut html = format!(
        r#"<h1>{}</h1><p>{}</p>{}<form method="post">{}{}"#,
        t.ret_title,
        t.ret_lead,
        s.alert(note),
        s.hidden(),
        s.password_field()
    );
    for password_box in &boxes {
        let name = if password_box.name.is_empty() {
            t.ret_unnamed.to_owned()
        } else {
            escape(&password_box.name.chars().take(120).collect::<String>())
        };
        html.push_str(&format!(r#"<section class="box"><h2>{name}</h2>"#));
        if password_box.candidates.is_empty() {
            html.push_str(&format!(
                r#"<p class="note">{}</p><p class="note">{}</p><a class="back" href="/app/vaults/{}/share">{}</a>"#,
                t.ret_pending, t.ret_join, password_box.id, t.ret_manage
            ));
        } else {
            html.push_str(&format!(
                r#"<label for="t-{id}">{}</label><select id="t-{id}" name="target.{id}" required>"#,
                t.ret_target,
                id = password_box.id
            ));
            for candidate in &password_box.candidates {
                html.push_str(&format!(
                    r#"<option value="{}">{}</option>"#,
                    candidate.id,
                    escape(candidate.email)
                ));
            }
            html.push_str(&format!(
                r#"</select><button type="submit" name="transfer" value="{}" formnovalidate>{}</button>"#,
                password_box.id, t.ret_transfer
            ));
        }
        html.push_str("</section>");
    }
    if more {
        html.push_str(&format!(r#"<p class="note">{}</p>"#, t.ret_more));
    }
    html.push_str(&format!(
        r#"<hr><label for="confirm">{}</label><input id="confirm" name="confirmationEmail" type="email" autocomplete="off" required><p class="note">{}</p><p class="note">{}</p><button class="danger" type="submit" name="delete" value="1">{}</button></form><a class="back" href="{}">{}</a>"#,
        t.ret_confirm, t.ret_private, t.ret_shared, t.ret_delete, s.hub(), t.hub
    ));
    Ok(html)
}

pub fn render(input: &Value) -> Value {
    let locale = match input["locale"].as_str() {
        Some("en") => "en",
        Some("ru") => "ru",
        _ => "ja",
    };
    let t = match locale {
        "en" => &EN,
        "ru" => &RU,
        _ => &JA,
    };
    let page = match input["page"].as_str() {
        Some("recovery-key") => Page::Key,
        Some("recover") => Page::Recover,
        Some("retire") => Page::Retire,
        _ => return error(400, "PS018", "Unknown page"),
    };
    let code = input["errorCode"].as_str().unwrap_or("");
    // Only a signed-in page has a session to lose; recovery has none.
    let session_lost = page != Page::Recover && matches!(code, "PS022" | "PS024" | "PS025");
    let state = if session_lost {
        "expired"
    } else {
        input["state"].as_str().unwrap_or("form")
    };
    let note = message(t, page, code);
    let shared = Shared { t, locale };
    let content = match page {
        Page::Key => key_page(&shared, state, note),
        Page::Recover => recover_page(&shared, state, note),
        Page::Retire => match retire_page(&shared, input, state, note) {
            Ok(content) => content,
            Err(failure) => return failure,
        },
    };
    let (title, current) = match page {
        Page::Key => (t.key_title, t.account),
        Page::Recover => (t.rec_title, t.account),
        Page::Retire => (t.ret_title, t.account),
    };
    let html = format!(
        r#"<!doctype html><html lang="{locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} | PassShare</title><style>{STYLE}{EXTRA_STYLE}</style></head><body>
<header><a class="brand" href="/app/vaults">PassShare</a><nav aria-label="PassShare"><a href="/app/vaults">{}</a><a href="/app/invitations">{}</a><span aria-current="page">{current}</span></nav></header><main>{content}<footer>{}</footer></main></body></html>"#,
        t.boxes, t.invitations, t.footer
    );
    json!({"status":200,"body":{"html":html,"csrfSlot":CSRF_SLOT,"keySlot":KEY_SLOT}})
}

fn password_shape(form: &Value) -> Result<(), Value> {
    match form["currentPassword"].as_str() {
        Some(value) if !value.is_empty() && value.len() <= 1024 => Ok(()),
        _ => Err(error(401, "PS026", "Invalid email or password")),
    }
}

fn text<'a>(form: &'a Value, name: &str) -> Option<&'a str> {
    form[name]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 1024)
}

/// Decide what a submitted page form asks for. The reply carries identifiers
/// only, never a password or key.
pub fn validate_form(input: &Value) -> Value {
    let form = &input["form"];
    let decision = match input["page"].as_str() {
        Some("recovery-key") => password_shape(form).map(|_| json!({"action":"issue"})),
        Some("recover") => {
            let invalid = || error(401, "PS026", "Invalid recovery credentials");
            if text(form, "email").is_none() || text(form, "recoveryKey").is_none() {
                Err(invalid())
            } else if form["confirmPassword"].as_str().is_none()
                || form["confirmPassword"] != form["newPassword"]
            {
                Err(error(400, "PS047", "New passwords do not match"))
            } else {
                Ok(json!({"action":"recover"}))
            }
        }
        Some("retire") => retire_decision(form),
        _ => Err(error(400, "PS018", "Unknown page")),
    };
    match decision {
        Ok(body) => json!({"status":200,"body":body}),
        Err(failure) => failure,
    }
}

fn retire_decision(form: &Value) -> Result<Value, Value> {
    password_shape(form)?;
    let invalid = || error(400, "PS018", "Invalid account form");
    match (form["transfer"].as_str(), form["delete"].as_str()) {
        (Some(id), None) => {
            if !valid_box_id(id) {
                return Err(invalid());
            }
            let target = form[format!("target.{id}")]
                .as_str()
                .filter(|v| valid_user_id(v))
                .ok_or_else(|| {
                    error(
                        409,
                        "PS047",
                        "A confirmed member is required for ownership transfer",
                    )
                })?;
            Ok(json!({"action":"transfer","vaultId":id,"targetUserId":target}))
        }
        (None, Some("1")) => match text(form, "confirmationEmail") {
            Some(_) => Ok(json!({"action":"delete"})),
            None => Err(error(
                400,
                "PS048",
                "Confirm the account email before deletion",
            )),
        },
        _ => Err(invalid()),
    }
}

const EXTRA_STYLE: &str = r#"
input[type=email],input[type=text],select{width:100%;border:1px solid #46596c;background:#1d2b3a;color:#f4f7fb;border-radius:8px;padding:14px;font:inherit}select{appearance:auto}
hr{border:0;border-top:1px solid #29394a;margin:32px 0}h2{font-size:20px;margin:28px 0 4px}.box{margin-top:12px}.box button{margin-top:16px}
.key{font-size:20px;letter-spacing:.04em;font-family:ui-monospace,Consolas,monospace;user-select:all;overflow-wrap:anywhere}
.notes{padding-left:20px;color:#bbc8d8;line-height:1.9}.note{font-size:14px;margin:12px 0}.ok{border-left:3px solid #91edce;padding:12px}
.danger{background:transparent;border:2px solid #ff5b4d;color:#ff5b4d}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    const ACTOR: &str = "11111111-1111-4111-8111-111111111111";
    const PEER: &str = "22222222-2222-4222-8222-222222222222";
    const WAITING: &str = "33333333-3333-4333-8333-333333333333";
    const BOX_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BOX_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn page(input: Value) -> String {
        let reply = render(&input);
        assert_eq!(reply["status"], 200, "{reply}");
        reply["body"]["html"].as_str().unwrap().to_owned()
    }

    fn member(id: &str, role: &str, confirmed: bool, email: &str) -> Value {
        json!({"user_id":id,"role":role,"identity_confirmed":confirmed,"email":email})
    }

    fn retire_input(boxes: Value) -> Value {
        json!({"page":"retire","locale":"ja","userId":ACTOR,"boxes":boxes})
    }

    #[test]
    fn every_form_has_one_unforgeable_slot_and_no_script() {
        for locale in ["ja", "en", "ru"] {
            for page_name in ["recovery-key", "recover"] {
                let html = page(json!({"page":page_name,"locale":locale}));
                assert_eq!(html.matches(CSRF_SLOT).count(), 1);
                assert_eq!(html.matches(KEY_SLOT).count(), 0);
                assert!(!html.contains("<script") && !html.contains("action="));
            }
            let issued = page(json!({"page":"recovery-key","state":"issued","locale":locale}));
            assert_eq!(issued.matches(KEY_SLOT).count(), 1);
            assert_eq!(issued.matches(CSRF_SLOT).count(), 0);
            assert!(issued.contains("readonly") && !issued.contains("<form"));
        }
    }

    #[test]
    fn user_data_cannot_imitate_a_slot() {
        let hostile = format!("{KEY_SLOT}{CSRF_SLOT}\" onfocus=\"x");
        let html = page(retire_input(json!([{"id":BOX_A,"name":hostile,
            "members":[member(ACTOR,"owner",true,"a@example.test"),member(PEER,"member",true,&hostile)]}])));
        assert_eq!(
            html.matches(CSRF_SLOT).count(),
            1,
            "only the real hidden field"
        );
        assert_eq!(html.matches(KEY_SLOT).count(), 0);
        assert!(html.contains("&quot; onfocus=&quot;x"));
    }

    #[test]
    fn secrets_in_the_request_never_reach_the_page() {
        let html = page(
            json!({"page":"recover","locale":"ja","currentPassword":"Synthetic-Do-Not-Render!",
            "recoveryKey":"K".repeat(43),"newPassword":"Synthetic-Next!","email":"synthetic@example.test",
            "errorCode":"<script>"}),
        );
        for secret in [
            "Synthetic-Do-Not-Render!",
            "Synthetic-Next!",
            "synthetic@example.test",
        ] {
            assert!(!html.contains(secret));
        }
        assert!(!html.contains(&"K".repeat(43)) && !html.contains("<script>"));
        assert!(
            html.contains("復旧できたか確認できません"),
            "unknown codes show a fixed error"
        );
        assert_eq!(
            html.matches("value=").count(),
            2,
            "only the proof slot and the locale carry values"
        );
    }

    #[test]
    fn copy_uses_the_approved_wording_in_three_locales() {
        for (locale, title, button) in [
            ("ja", "復旧キーを保管する", "復旧キーを発行"),
            ("en", "Keep your recovery key", "Issue recovery key"),
            (
                "ru",
                "Сохраните ключ восстановления",
                "Выпустить ключ восстановления",
            ),
        ] {
            let html = page(json!({"page":"recovery-key","locale":locale}));
            assert!(html.contains(title) && html.contains(button));
            assert!(html.contains("暗号") || html.contains("encrypt") || html.contains("шифр"));
            assert!(!html.contains("金庫") && !html.contains("Vault") && !html.contains("ボルト"));
        }
        let ja = page(json!({"page":"recover","locale":"ja"}));
        for text in [
            "アカウントを復旧する",
            "メールアドレス",
            "復旧キー",
            "新しいパスワードをもう一度",
            "復旧してログインへ",
            "すべての端末からログアウト",
        ] {
            assert!(ja.contains(text), "{text}");
        }
    }

    #[test]
    fn recovery_failures_share_one_message_and_session_loss_offers_login() {
        let invalid = page(json!({"page":"recover","errorCode":"PS026"}));
        assert!(invalid.contains("メールアドレスまたは復旧キーが正しくありません"));
        let lost = page(json!({"page":"recovery-key","errorCode":"PS024"}));
        assert!(!lost.contains("<form") && lost.contains("/app/login"));
        let recovery_without_session = page(json!({"page":"recover","errorCode":"PS024"}));
        assert!(recovery_without_session.contains("<form"));
        assert_eq!(render(&json!({"page":"other"}))["status"], 400);
    }

    #[test]
    fn retirement_repeats_the_approved_control_for_each_blocking_box() {
        let owner = |name: &str| member(ACTOR, "owner", true, name);
        let html = page(retire_input(json!([
            {"id":BOX_A,"name":"First","members":[owner("a"),member(PEER,"member",true,"peer@example.test")]},
            {"id":BOX_B,"name":"Second","members":[owner("a"),member(PEER,"member",true,"peer@example.test")]},
            {"id":"cccccccccccccccccccccccccc","name":"Private","members":[owner("a")]},
            {"id":"dddddddddddddddddddddddddd","name":"Co-owned","members":[owner("a"),member(PEER,"owner",true,"p")]},
        ])));
        assert_eq!(html.matches("name=\"transfer\"").count(), 2);
        assert_eq!(html.matches("<select").count(), 2);
        assert_eq!(html.matches("name=\"delete\"").count(), 1);
        assert!(html.contains("First") && html.contains("Second"));
        assert!(!html.contains("Private") && !html.contains("Co-owned"));
        assert_eq!(html.matches("formnovalidate").count(), 2);
        assert!(html.contains("本人だけのパスワードボックスは削除します"));
    }

    #[test]
    fn unconfirmed_members_cannot_receive_ownership_and_get_real_routes() {
        let html = page(retire_input(json!([{"id":BOX_A,"name":"Legacy","members":[
            member(ACTOR,"owner",true,"a"),
            member(WAITING,"member",false,"waiting@example.test")]}])));
        assert!(!html.contains("<select") && !html.contains("name=\"transfer\""));
        assert!(!html.contains("waiting@example.test"));
        assert!(html.contains(&format!("href=\"/app/vaults/{BOX_A}/share\"")));
        assert!(html.contains("招待"));
        let none = page(retire_input(json!([])));
        assert!(none.contains("name=\"delete\"") && !none.contains("<section"));
    }

    #[test]
    fn page_size_is_bounded_and_data_is_validated() {
        let boxes: Vec<Value> = (0..25)
            .map(|i| {
                json!({"id":format!("{i:0>26}"),"name":"x","members":[
                member(ACTOR,"owner",true,"a"),member(PEER,"member",true,"p")]})
            })
            .collect();
        let html = page(retire_input(json!(boxes)));
        assert_eq!(html.matches("name=\"transfer\"").count(), MAX_BOXES);
        assert!(html.contains("ほかにも共有ボックスがあります"));
        for bad in [
            json!([{"id":"short","members":[]}]),
            json!([{"id":BOX_A,"members":[{"user_id":"not-a-user"}]}]),
        ] {
            assert_eq!(render(&retire_input(bad))["status"], 400);
        }
        assert_eq!(render(&json!({"page":"retire","boxes":[]}))["status"], 400);
    }

    #[test]
    fn the_page_list_matches_the_deletion_decision() {
        let actor = ACTOR;
        for others in [
            vec![],
            vec!["member"],
            vec!["owner"],
            vec!["member", "owner"],
        ] {
            let mut members = vec![member(actor, "owner", true, "a")];
            members.extend(others.iter().map(|role| member(PEER, role, true, "p")));
            let hash = format!("$argon2id{}{}", '$', "a".repeat(80));
            let decision = super::super::retirement::retire(&json!({
                "sessionExists":true,"currentHash":hash,"verifiedHash":hash,"userId":actor,
                "email":"a@example.test","confirmationEmail":"a@example.test",
                "boxes":[{"id":BOX_A,"members":members}]}));
            assert_eq!(decision["status"] == 409, needs_transfer(actor, &members));
        }
    }

    #[test]
    fn forms_decide_actions_without_echoing_values() {
        let secret = "Synthetic-Current!";
        let issue =
            validate_form(&json!({"page":"recovery-key","form":{"currentPassword":secret}}));
        assert_eq!(issue["body"]["action"], "issue");
        assert!(!issue.to_string().contains(secret));
        for form in [
            json!({}),
            json!({"currentPassword":""}),
            json!({"currentPassword":["x"]}),
        ] {
            assert_eq!(
                validate_form(&json!({"page":"recovery-key","form":form}))["status"],
                401
            );
        }
        let recover = |again: &str| {
            validate_form(&json!({"page":"recover","form":{
            "email":"a@example.test","recoveryKey":"K".repeat(43),"newPassword":"Synthetic-N1!","confirmPassword":again}}))
        };
        assert_eq!(recover("Synthetic-N1!")["body"]["action"], "recover");
        assert_eq!(recover("Synthetic-N1! ")["code"], "PS047");
        let transfer =
            json!({"currentPassword":secret,"transfer":BOX_A,format!("target.{BOX_A}"):PEER});
        let decided = validate_form(&json!({"page":"retire","form":transfer}));
        assert_eq!(
            decided["body"],
            json!({"action":"transfer","vaultId":BOX_A,"targetUserId":PEER})
        );
        let missing =
            json!({"currentPassword":secret,"transfer":BOX_A,format!("target.{BOX_B}"):PEER});
        assert_eq!(
            validate_form(&json!({"page":"retire","form":missing}))["code"],
            "PS047"
        );
        let delete =
            json!({"currentPassword":secret,"delete":"1","confirmationEmail":"a@example.test"});
        assert_eq!(
            validate_form(&json!({"page":"retire","form":delete}))["body"]["action"],
            "delete"
        );
        let both = json!({"currentPassword":secret,"delete":"1","transfer":BOX_A,"confirmationEmail":"a@example.test"});
        assert_eq!(
            validate_form(&json!({"page":"retire","form":both}))["status"],
            400
        );
        let no_email = json!({"currentPassword":secret,"delete":"1"});
        assert_eq!(
            validate_form(&json!({"page":"retire","form":no_email}))["code"],
            "PS048"
        );
        assert_eq!(
            validate_form(
                &json!({"page":"retire","form":{"currentPassword":secret,"transfer":"../x"}})
            )["status"],
            400
        );
    }
}
