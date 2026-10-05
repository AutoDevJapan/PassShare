import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";
import {
  acceptInvitation,
  AuthApiError,
  declineInvitation,
  listPendingInvitations,
  type ShareInvitation,
} from "../../lib/auth-api";
import { useAuthSession } from "../../hooks/useAuthSession";

export function InvitationsPage() {
  const { t } = useI18n();
  const { refreshConnect } = useAuthSession();
  const [invitations, setInvitations] = useState<ShareInvitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setInvitations(await listPendingInvitations());
    } catch (err) {
      setError(err instanceof AuthApiError && err.code === "PS045" ? t("app.invitations.confirmationError")
        : err instanceof Error ? err.message : t("app.invitations.loadError"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAccept(invitationId: string) {
    setBusyId(invitationId);
    setError(null);
    try {
      await acceptInvitation(invitationId, codes[invitationId]?.trim() ?? "");
      setCodes((current) => { const next = { ...current }; delete next[invitationId]; return next; });
      await refreshConnect();
      await load();
    } catch (err) {
      setError(err instanceof AuthApiError && err.code === "PS045" ? t("app.invitations.confirmationError")
        : err instanceof Error ? err.message : t("app.invitations.loadError"));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDecline(invitationId: string) {
    setBusyId(invitationId);
    setError(null);
    try {
      await declineInvitation(invitationId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.invitations.loadError"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="app-page">
      <header className="app-page__header">
        <h1 className="ps-heading-2">{t("app.invitations.title")}</h1>
        <p className="app-page__lead">{t("app.invitations.lead")}</p>
      </header>

      {error ? (
        <p className="ps-error" role="alert">
          {error}
        </p>
      ) : null}

      {invitations.length === 0 ? <p>{t("app.invitations.empty")}</p> : null}

      <ul className="app-share-list">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="ps-card app-share-row">
            <div>
              <strong>{invitation.vaultName}</strong>
              <p>
                {t("app.invitations.from")} {invitation.inviterEmail}
              </p>
            </div>
            <div className="app-share-actions">
              <label className="ps-label ps-label--full">
                {t("app.invitations.confirmationLabel")}
                <input className="ps-input" type="password" autoComplete="off" maxLength={43}
                  aria-describedby={`confirmation-help-${invitation.id}`}
                  value={codes[invitation.id] ?? ""} disabled={busyId !== null}
                  placeholder={t("app.invitations.confirmationPlaceholder")}
                  onChange={(event) => setCodes((current) => ({ ...current, [invitation.id]: event.target.value }))} />
              </label>
              <p id={`confirmation-help-${invitation.id}`}>{t("app.invitations.confirmationHelp")}</p>
              <button
                type="button"
                className="ps-button"
                disabled={busyId !== null || (codes[invitation.id]?.trim().length ?? 0) !== 43}
                onClick={() => void handleAccept(invitation.id)}
              >
                {t("app.invitations.confirmAccept")}
              </button>
              <button
                type="button"
                className="ps-button ps-button--secondary"
                disabled={busyId !== null}
                onClick={() => void handleDecline(invitation.id)}
              >
                {t("app.invitations.decline")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
