import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import {
  AuthApiError,
  inviteToVault,
  listVaultInvitations,
  listVaultMembers,
  removeVaultMember,
  revokeVaultInvitation,
  type ShareInvitation,
  type VaultMember,
} from "../../lib/auth-api";
import { useAuthSession } from "../../hooks/useAuthSession";

export function VaultSharePage() {
  const { vaultId = "" } = useParams();
  const { t } = useI18n();
  const { user, refreshConnect } = useAuthSession();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invitations, setInvitations] = useState<ShareInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<ShareInvitation | null>(null);

  const isOwner = members.some(
    (member) => member.userId === user?.id && member.role === "owner",
  );

  const loadMembers = useCallback(async () => {
    if (!vaultId) {
      return [];
    }
    const nextMembers = await listVaultMembers(vaultId);
    setMembers(nextMembers);
    return nextMembers;
  }, [vaultId]);

  const loadInvitations = useCallback(async () => {
    if (!vaultId) {
      return;
    }
    setInvitations(await listVaultInvitations(vaultId));
  }, [vaultId]);

  useEffect(() => {
    void (async () => {
      setError(null);
      try {
        const nextMembers = await loadMembers();
        const owner = nextMembers.some(
          (member) => member.userId === user?.id && member.role === "owner",
        );
        if (owner) {
          await loadInvitations();
        } else {
          setInvitations([]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t("app.share.loadError"));
      }
    })();
  }, [loadMembers, loadInvitations, user?.id, t]);

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (busy || !vaultId || !email.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const invitation = await inviteToVault(vaultId, email.trim());
      setConfirmation(invitation);
      setEmail("");
      await loadInvitations();
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : t("app.share.inviteError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!vaultId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await removeVaultMember(vaultId, memberId);
      await loadMembers();
      await refreshConnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.share.loadError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(invitationId: string) {
    if (!vaultId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await revokeVaultInvitation(vaultId, invitationId);
      if (confirmation?.id === invitationId) setConfirmation(null);
      await loadInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.share.loadError"));
    } finally {
      setBusy(false);
    }
  }

  function roleLabel(role: string) {
    return role === "owner" ? t("app.share.roleOwner") : t("app.share.roleMember");
  }

  return (
    <section className="app-page">
      <header className="app-page__header">
        <Link to={`/app/vaults/${vaultId}/items`} className="app-back-link">
          {t("app.share.backToItems")}
        </Link>
        <h1 className="ps-heading-2">{t("app.share.title")}</h1>
        <p className="app-page__lead">{t("app.share.lead")}</p>
      </header>

      {error ? (
        <p className="ps-error" role="alert">
          {error}
        </p>
      ) : null}

      {isOwner ? (
        <form className="app-inline-form ps-card" onSubmit={(event) => void handleInvite(event)}>
          <label className="ps-label ps-label--full">
            {t("app.share.inviteLabel")}
            <input
              className="ps-input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("app.share.invitePlaceholder")}
            />
          </label>
          <button type="submit" className="ps-button" disabled={busy || !email.trim()}>
            {t("app.share.inviteSubmit")}
          </button>
        </form>
      ) : null}

      {isOwner && confirmation?.confirmationCode ? (
        <section className="ps-card app-share-section" role="status">
          <h2 className="ps-heading-3">{t("app.share.confirmationHeading")}</h2>
          <p>{confirmation.email}</p>
          <p>{t("app.share.confirmationHelp")}</p>
          <label className="ps-label">
            {t("app.invitations.confirmationLabel")}
            <input className="ps-input" readOnly value={confirmation.confirmationCode} autoComplete="off"
              onFocus={(event) => event.target.select()} />
          </label>
          <p>{t("app.share.confirmationOnce")}</p>
          <button type="button" className="ps-button ps-button--secondary"
            onClick={() => setConfirmation(null)}>{t("app.share.confirmationDismiss")}</button>
        </section>
      ) : null}

      <section className="ps-card app-share-section">
        <h2 className="ps-heading-3">{t("app.share.membersHeading")}</h2>
        <ul className="app-share-list">
          {members.map((member) => (
            <li key={member.userId} className="app-share-row">
              <span>
                {member.email} — {roleLabel(member.role)}
              </span>
              {isOwner && member.role !== "owner" ? (
                <button
                  type="button"
                  className="ps-button ps-button--secondary"
                  disabled={busy}
                  onClick={() => void handleRemoveMember(member.userId)}
                >
                  {t("app.share.removeMember")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {isOwner && invitations.length > 0 ? (
        <section className="ps-card app-share-section">
          <h2 className="ps-heading-3">{t("app.share.pendingHeading")}</h2>
          <ul className="app-share-list">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="app-share-row">
                <span>{invitation.email}</span>
                <button
                  type="button"
                  className="ps-button ps-button--secondary"
                  disabled={busy}
                  onClick={() => void handleRevoke(invitation.id)}
                >
                  {t("app.share.revokeInvitation")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
