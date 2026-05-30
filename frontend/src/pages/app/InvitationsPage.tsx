import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";
import {
  acceptInvitation,
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

  const load = useCallback(async () => {
    setError(null);
    try {
      setInvitations(await listPendingInvitations());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.invitations.loadError"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAccept(invitationId: string) {
    setBusyId(invitationId);
    setError(null);
    try {
      await acceptInvitation(invitationId);
      await refreshConnect();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.invitations.loadError"));
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
              <button
                type="button"
                className="ps-button"
                disabled={busyId === invitation.id}
                onClick={() => void handleAccept(invitation.id)}
              >
                {t("app.invitations.accept")}
              </button>
              <button
                type="button"
                className="ps-button ps-button--secondary"
                disabled={busyId === invitation.id}
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
