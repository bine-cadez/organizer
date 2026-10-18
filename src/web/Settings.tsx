import { useEffect, useState } from "react";
import { request, safe, timeOf } from "./api";
import { useApp } from "./context";
import { Button, Empty, Icon, PageHeader, Tile } from "./ui";

export function Onboarding() {
  const { state, command, navigate, setModal } = useApp();
  const continueSetup = () =>
    safe(command("skip_setup", {}, true).then(() => navigate("today")));
  return (
    <div className="onboarding">
      <aside className="onboarding-side">
        <a className="brand" href="#/today">
          <span className="brand-mark">O</span>Organizer
        </a>
        <h1>Four areas. Two places at each.</h1>
        <p>
          Every area keeps one place for a project and one for a book.
          Everything else waits in Up next until a place opens.
        </p>
        <div className="onboarding-areas">
          {state.areas.map((area) => (
            <div key={area.id}>
              <Tile area={area.id} />
              <span>{area.fullName}</span>
              <span className="place-marks" aria-hidden="true">
                ▯ ▯
              </span>
            </div>
          ))}
        </div>
      </aside>
      <div className="onboarding-content">
        <PageHeader
          title="Set up in two steps"
          subtitle="Connect your calendars, then reserve your first place. You can add the rest later."
        />
        <section className="setup-step">
          <span className="step-number">1</span>
          <div>
            <h2>Connect your Google calendars</h2>
            {(["personal", "work"] as const).map((role) => {
              const connection = state.connections.find((c) => c.role === role);
              const connected = connection?.status === "connected";
              return (
                <div className="account-card" key={role}>
                  <Icon name={role} />
                  <div>
                    <strong>
                      {role === "personal"
                        ? "Personal account"
                        : "Work account"}
                    </strong>
                    <small>
                      {connection?.email ? `${connection.email} · ` : ""}
                      {role === "personal"
                        ? "reads events and creates events when you book time"
                        : "Read-only. Meetings show as busy time; nothing is ever written here."}
                    </small>
                  </div>
                  {connected ? (
                    <span className="connected-chip">
                      <Icon name="check" />
                      Connected
                    </span>
                  ) : (
                    <a
                      className="button primary"
                      href={`/auth/calendar?role=${role}`}
                    >
                      {connection ? "Reconnect" : "Connect Google"}
                    </a>
                  )}
                </div>
              );
            })}
            <p className="muted">
              You can skip Work for now; Today and the week view will show
              Personal only.
            </p>
          </div>
        </section>
        <section className="setup-step">
          <span className="step-number outline">2</span>
          <div>
            <h2>Reserve your first place</h2>
            <p>
              Pick an area and add the one project or book you're working on
              now. Add more to Up next whenever you like.
            </p>
            <div className="setup-area-grid">
              {state.areas.map((area) => {
                const items = state.items.filter(
                  (i) => i.areaId === area.id && i.state === "active",
                );
                return (
                  <button
                    key={area.id}
                    onClick={() =>
                      setModal({ type: "add", areaId: area.id, start: true })
                    }
                  >
                    <Tile large area={area.id} />
                    <span>
                      <strong>{area.fullName}</strong>
                      <small>
                        Project place{" "}
                        {items.some((i) => i.kind === "project")
                          ? "reserved"
                          : "open"}{" "}
                        · Book place{" "}
                        {items.some((i) => i.kind === "book")
                          ? "reserved"
                          : "open"}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
        <div className="setup-footer">
          <Button primary onClick={continueSetup}>
            Continue <Icon name="next" />
          </Button>
          <Button ghost onClick={continueSetup}>
            Skip setup
          </Button>
        </div>
      </div>
    </div>
  );
}
type Client = {
  id: string;
  name: string;
  scopes?: string[];
  createdAt?: string;
};
export function Settings({
  session,
}: {
  session: { email?: string; localDevelopment: boolean };
}) {
  const { state, command, notify } = useApp();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientError, setClientError] = useState("");
  const loadClients = () =>
    request<{ clients: Client[] }>("/api/clients")
      .then((result) => setClients(result.clients ?? []))
      .catch(() =>
        setClientError(
          "Client connections will appear here after OAuth is configured.",
        ),
      );
  useEffect(() => {
    safe(loadClients());
  }, []);
  const endpoint = `${location.origin}/mcp`;
  const operations = state.operations.filter(
    (o) => !["succeeded", "superseded"].includes(o.status),
  );
  return (
    <>
      <PageHeader
        title="Account & agents"
        subtitle="Your calendars, agent access, and connection status."
      />
      <div className="settings-grid">
        <section className="panel">
          <h2>Your account</h2>
          <p>
            {session.email ??
              (session.localDevelopment
                ? "Local development session"
                : "Organizer owner")}
          </p>
          <p className="muted">Europe/Ljubljana · en-GB · 24-hour time</p>
          <a className="button" href="#/setup">
            Open setup
          </a>
          {!session.localDevelopment && (
            <Button
              ghost
              onClick={() =>
                safe(
                  request("/auth/logout", {
                    method: "POST",
                    headers: { "X-Organizer-Request": "1" },
                  }).then(() => location.reload()),
                )
              }
            >
              Sign out
            </Button>
          )}
        </section>
        <section className="panel">
          <h2>Google calendars</h2>
          {(["personal", "work"] as const).map((role) => {
            const connection = state.connections.find((c) => c.role === role);
            return (
              <div className="settings-connection" key={role}>
                <Icon name={role} />
                <div>
                  <h3>
                    {role === "personal"
                      ? "Personal · can book"
                      : "Work · read-only"}
                  </h3>
                  <p>{connection?.email ?? "Not connected"}</p>
                  {connection && (
                    <small>
                      {connection.status === "connected"
                        ? "Connected"
                        : "Reconnect needed"}
                      {connection.lastSyncedAt
                        ? ` · Last updated ${timeOf(connection.lastSyncedAt)}`
                        : ""}
                    </small>
                  )}
                </div>
                <a
                  className="button small"
                  href={`/auth/calendar?role=${role}`}
                >
                  {connection?.status === "connected"
                    ? "Reconnect"
                    : "Connect Google"}
                </a>
              </div>
            );
          })}
          <Button
            small
            onClick={() => safe(command("request_calendar_sync", {}))}
          >
            Refresh calendars
          </Button>
        </section>
        <section className="panel mcp-settings">
          <h2>Connect your agents</h2>
          <p>
            Give your agent this remote MCP server URL. Sign in as the owner,
            then choose the capabilities that client may use.
          </p>
          <div className="copy-endpoint">
            <code>{endpoint}</code>
            <Button
              small
              onClick={() =>
                safe(
                  navigator.clipboard
                    .writeText(endpoint)
                    .then(() => notify("MCP server URL copied.")),
                )
              }
            >
              Copy URL
            </Button>
          </div>
          <p className="muted">
            Connected agents act within their granted permissions. The same
            place limits and project rules apply.
          </p>
          <h3>Connected clients</h3>
          {clients.length ? (
            clients.map((client) => (
              <div className="client-row" key={client.id}>
                <div>
                  <strong>{client.name}</strong>
                  <small>{client.scopes?.join(" · ")}</small>
                </div>
                <Button
                  small
                  onClick={() =>
                    safe(
                      request(
                        `/api/clients/${encodeURIComponent(client.id)}/revoke`,
                        {
                          method: "POST",
                          headers: { "X-Organizer-Request": "1" },
                        },
                      )
                        .then(loadClients)
                        .then(() => notify("Client access revoked.")),
                    )
                  }
                >
                  Revoke access
                </Button>
              </div>
            ))
          ) : (
            <p className="muted">{clientError || "No agents connected yet."}</p>
          )}
        </section>
        <section className="panel">
          <h2>Calendar synchronization</h2>
          {operations.length ? (
            operations.map((operation) => (
              <div className="operation-row" key={operation.id}>
                <div>
                  <strong>{operation.action}</strong>
                  <small>
                    {operation.status.replaceAll("_", " ")} ·{" "}
                    {operation.attempts} attempts
                  </small>
                  {operation.error && (
                    <p className="error-text">{operation.error}</p>
                  )}
                </div>
                {["failed", "needs_reconnect"].includes(operation.status) && (
                  <div className="operation-actions">
                    <Button
                      small
                      onClick={() =>
                        safe(
                          command("retry_operation", {
                            operationId: operation.id,
                          }),
                        )
                      }
                    >
                      Retry
                    </Button>
                    {["create", "update"].includes(operation.action) && (
                      <Button
                        small
                        ghost
                        onClick={() =>
                          safe(
                            command("undo_booking_change", {
                              operationId: operation.id,
                            }),
                          )
                        }
                      >
                        Undo
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))
          ) : (
            <p className="muted">No pending calendar changes.</p>
          )}
        </section>
      </div>
    </>
  );
}
