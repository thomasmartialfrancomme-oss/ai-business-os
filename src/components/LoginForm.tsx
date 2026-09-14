"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({
  users,
  next,
}: {
  users: Array<{ id: string; email: string; name: string; role: string; plan: string | null; status: string | null }>;
  next: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function login(userId: string) {
    setBusy(userId);
    setError(null);
    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = (await response.json()) as { redirectTo?: string; message?: string };
      if (!response.ok) {
        setError(data.message ?? "Connexion impossible.");
        return;
      }
      router.push(next ?? data.redirectTo ?? "/billing");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>Rôle</th>
              <th>Abonnement</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.name}</strong>
                  <div className="dim">{user.email}</div>
                </td>
                <td>
                  {user.role === "OWNER" ? (
                    <span className="badge badge-primary">Propriétaire</span>
                  ) : (
                    <span className="badge badge-neutral">Client</span>
                  )}
                </td>
                <td className="dim">
                  {user.plan ? `${user.plan} — ${user.status}` : "Aucun abonnement"}
                </td>
                <td className="right">
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => login(user.id)}>
                    {busy === user.id ? <span className="spinner" /> : null}
                    Se connecter
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="dim">
                  Aucun utilisateur en base. Exécutez <span className="mono">npm run db:seed</span>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
