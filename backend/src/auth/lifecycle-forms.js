import { urlencoded } from "express";
import { authHttpError, sendAuthError } from "./errors.js";
import { nativeMutation } from "../lib/native-mutations.js";

// Script-free pages for the recovery key, account recovery and retirement.
// Every decision (copy, which boxes block deletion, what a form asks for) is
// made by the native service; this adapter routes, binds server generated
// proofs and persists through the same operations as the JSON endpoints.
// Passwords and recovery keys are never given to the page renderer, and
// nothing here writes request bodies to a log.

const PAGE_CODES = new Set([
  "PS018", "PS019", "PS020", "PS021", "PS022", "PS024", "PS025", "PS026", "PS027",
  "PS028", "PS029", "PS032", "PS047", "PS048", "PS049",
]);
const SESSION_LOST = new Set(["PS022", "PS024", "PS025"]);
const BOX_LIMIT = 20;
const FORM_BODY_LIMIT = "16kb";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RETRY_AFTER_FAILURE_MS = 5000;
const MAX_TEMPLATES = 256;

export function registerLifecycleForms({
  router, authStore, connectStore, appEnv, sessionGuard, pageThrottle, formThrottle,
  htmlFormCsrf, requireCsrf, issueCsrfToken, sendHtml, pageContext, operations,
}) {
  const parseForm = urlencoded({ extended: false, limit: FORM_BODY_LIMIT });
  const templates = new Map();

  // Pages without per-user data are rendered once per (page, state, error,
  // locale) and shared. Keys come from fixed sets, so the map is bounded; a
  // failed render is remembered briefly and then retried without a restart.
  function template(spec) {
    const errorCode = PAGE_CODES.has(spec.errorCode) ? spec.errorCode : spec.errorCode ? "PS019" : "";
    const key = [spec.page, spec.state, errorCode, spec.locale].join("|");
    let entry = templates.get(key);
    if (!entry || Date.now() >= entry.retryAt) {
      if (templates.size >= MAX_TEMPLATES) templates.clear();
      entry = { retryAt: Infinity };
      entry.promise = nativeMutation({ command: "account-lifecycle-page", ...spec, errorCode })
        .catch((error) => { entry.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS; throw error; });
      templates.set(key, entry);
    }
    return entry.promise;
  }

  function fill(html, slot, token) {
    const parts = html.split(slot);
    if (!TOKEN_PATTERN.test(token) || parts.length !== 2) {
      throw authHttpError(500, "PS019", "Page could not be prepared");
    }
    return parts.join('value="' + token + '"');
  }

  // Only whole output attributes are replaced, with a validated 43 character
  // token, so no user data in the page can be mistaken for a slot.
  function bind(page, { csrf, key } = {}) {
    let html = page.html;
    if (csrf !== undefined) html = fill(html, page.csrfSlot, csrf);
    if (key !== undefined) html = fill(html, page.keySlot, key);
    if (html.includes(page.csrfSlot) || html.includes(page.keySlot)) {
      throw authHttpError(500, "PS019", "Page could not be prepared");
    }
    return html;
  }

  const fixedPage = async (spec, tokens) => bind(await template({ errorCode: "", ...spec }), tokens);
  const handle = (action) => async (req, res, next) => {
    try { await action(req, res); } catch (error) { next(error); }
  };
  const localeOf = (req) => pageContext(req).locale;

  async function renderRetire(req, res, status = 200, errorCode = "") {
    const locale = localeOf(req);
    const rows = await authStore.listSoleOwnedSharedBoxes(req.auth.userId, BOX_LIMIT + 1);
    const boxes = [];
    for (const row of rows.slice(0, BOX_LIMIT)) {
      const box = await connectStore.getVault(row.id).catch(() => null);
      boxes.push({ id: row.id, name: box?.name ?? "", members: row.members });
    }
    const page = await nativeMutation({ command: "account-lifecycle-page", page: "retire", state: "form",
      locale, errorCode, userId: req.auth.userId, boxes, more: rows.length > BOX_LIMIT });
    sendHtml(res, status, bind(page, { csrf: issueCsrfToken(res, appEnv) }));
  }

  const KEY = "/account/recovery-key";
  const RECOVER = "/account/recover";
  const RETIRE = "/account/retire";

  router.get(KEY, pageThrottle, sessionGuard, handle(async (req, res) => {
    sendHtml(res, 200, await fixedPage({ page: "recovery-key", state: "form", locale: localeOf(req) },
      { csrf: issueCsrfToken(res, appEnv) }));
  }));

  router.post(KEY, formThrottle, sessionGuard, parseForm, htmlFormCsrf, requireCsrf, handle(async (req, res) => {
    const locale = localeOf(req);
    await nativeMutation({ command: "account-lifecycle-form", page: "recovery-key", form: req.body });
    const { receipt } = await operations.issueRecoveryKey(req, {
      prepare: (recoveryKey) => fixedPage({ page: "recovery-key", state: "issued", locale }, { key: recoveryKey }),
    });
    sendHtml(res, 200, receipt);
  }));

  // No session: the per-process budget runs before any other work.
  router.get(RECOVER, pageThrottle, handle(async (req, res) => {
    sendHtml(res, 200, await fixedPage({ page: "recover", state: "form", locale: localeOf(req) },
      { csrf: issueCsrfToken(res, appEnv) }));
  }));

  router.post(RECOVER, formThrottle, parseForm, htmlFormCsrf, requireCsrf, handle(async (req, res) => {
    const locale = localeOf(req);
    await nativeMutation({ command: "account-lifecycle-form", page: "recover", form: req.body });
    const receipt = await operations.recoverAccount(req, res, {
      prepare: () => fixedPage({ page: "recover", state: "done", locale }),
    });
    sendHtml(res, 200, receipt);
  }));

  router.get(RETIRE, pageThrottle, sessionGuard, handle((req, res) => renderRetire(req, res)));

  router.post(RETIRE, formThrottle, sessionGuard, parseForm, htmlFormCsrf, requireCsrf, handle(async (req, res) => {
    const locale = localeOf(req);
    const decision = await nativeMutation({ command: "account-lifecycle-form", page: "retire", form: req.body });
    const prepare = (state) => () => fixedPage({ page: "retire", state, locale });
    const receipt = decision.action === "transfer"
      ? await operations.transferOwnership(req, decision.vaultId, decision.targetUserId, { prepare: prepare("transferred") })
      : await operations.retireAccount(req, res, req.body.confirmationEmail, { prepare: prepare("deleted") });
    sendHtml(res, 200, receipt);
  }));

  function errorPage(page) {
    return async (error, req, res, next) => {
      if (error.status === 429) { sendAuthError(res, error); return; }
      try {
        const status = Number.isInteger(error.status) ? error.status : 500;
        const signedIn = page === "recover" || !!req.auth;
        const errorCode = signedIn ? (PAGE_CODES.has(error.code) ? error.code : "PS019") : "PS024";
        if (page === "retire" && !SESSION_LOST.has(errorCode)) {
          await renderRetire(req, res, status, errorCode);
          return;
        }
        const lost = page !== "recover" && SESSION_LOST.has(errorCode);
        const html = await fixedPage({ page, state: "form", locale: localeOf(req), errorCode },
          lost ? {} : { csrf: issueCsrfToken(res, appEnv) });
        sendHtml(res, status, html);
      } catch (renderError) { next(renderError); }
    };
  }

  router.use(KEY, errorPage("recovery-key"));
  router.use(RECOVER, errorPage("recover"));
  router.use(RETIRE, errorPage("retire"));
}
