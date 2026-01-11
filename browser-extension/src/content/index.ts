/**
 * PassShare Browser Extension - Content Script
 *
 * Handles form detection and auto-fill on web pages.
 */

interface LoginForm {
  form: HTMLFormElement | null;
  usernameField: HTMLInputElement | null;
  passwordField: HTMLInputElement | null;
}

interface SecretData {
  password: string;
  data: Record<string, string>;
}

// Find login forms on the page
function findLoginForms(): LoginForm[] {
  const forms: LoginForm[] = [];
  const passwordFields = document.querySelectorAll<HTMLInputElement>(
    'input[type="password"]:not([disabled])'
  );

  for (const passwordField of passwordFields) {
    // Find the containing form
    const form = passwordField.closest('form');

    // Find username/email field
    let usernameField: HTMLInputElement | null = null;

    // Check within the same form first
    if (form) {
      usernameField =
        form.querySelector<HTMLInputElement>(
          'input[type="email"]:not([disabled]),' +
            'input[type="text"][name*="user" i]:not([disabled]),' +
            'input[type="text"][name*="email" i]:not([disabled]),' +
            'input[type="text"][name*="login" i]:not([disabled]),' +
            'input[type="text"][id*="user" i]:not([disabled]),' +
            'input[type="text"][id*="email" i]:not([disabled]),' +
            'input[type="text"][autocomplete="username"]:not([disabled]),' +
            'input[type="text"][autocomplete="email"]:not([disabled])'
        ) || null;
    }

    // If no form, look for nearby username field
    if (!usernameField) {
      const container = passwordField.closest('div, section, main') || document.body;
      usernameField =
        container.querySelector<HTMLInputElement>(
          'input[type="email"]:not([disabled]),' +
            'input[type="text"][autocomplete="username"]:not([disabled])'
        ) || null;
    }

    forms.push({
      form,
      usernameField,
      passwordField,
    });
  }

  return forms;
}

// Fill a login form with credentials
function fillForm(form: LoginForm, data: SecretData): void {
  const { usernameField, passwordField } = form;

  // Get username from secret data
  const username =
    data.data['username'] ||
    data.data['user'] ||
    data.data['email'] ||
    data.data['login'] ||
    '';

  // Fill username
  if (usernameField && username) {
    usernameField.value = username;
    usernameField.dispatchEvent(new Event('input', { bubbles: true }));
    usernameField.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Fill password
  if (passwordField && data.password) {
    passwordField.value = data.password;
    passwordField.dispatchEvent(new Event('input', { bubbles: true }));
    passwordField.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Handle messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'fill' && message.data) {
    const forms = findLoginForms();
    if (forms.length > 0) {
      fillForm(forms[0], message.data);
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'No login form found' });
    }
  }

  if (message.action === 'detectForms') {
    const forms = findLoginForms();
    sendResponse({
      success: true,
      data: forms.map((f) => ({
        hasUsername: !!f.usernameField,
        hasPassword: !!f.passwordField,
        hasForm: !!f.form,
      })),
    });
  }

  return true;
});

// Detect and highlight fillable forms (optional feature)
function highlightFillableFields(): void {
  const forms = findLoginForms();
  for (const form of forms) {
    if (form.passwordField) {
      // Add a subtle indicator that this field is detected
      form.passwordField.dataset.passshareDetected = 'true';
    }
    if (form.usernameField) {
      form.usernameField.dataset.passshareDetected = 'true';
    }
  }
}

// Run detection on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', highlightFillableFields);
} else {
  highlightFillableFields();
}

// Re-detect on dynamic content changes
const observer = new MutationObserver(() => {
  highlightFillableFields();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});
