import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/types";
import { ApiError, request, safe } from "./api";
import { AppContext, type ModalState } from "./context";
import { Button, Icon } from "./ui";
import {
  Board,
  Project,
  Today,
  Drawer,
  AddDialog,
  EditDialog,
  SwapDialog,
  FinishDialog,
} from "./Core";
import { Bookshelf, FindBook } from "./Books";
import { BookTime, Calendar } from "./Calendar";
import { ReviewScreen } from "./Review";
import { Onboarding, Settings } from "./Settings";

const nav = [
  ["today", "Today"],
  ["board", "Board"],
  ["calendar", "Calendar"],
  ["bookshelf", "Bookshelf"],
  ["review", "Evening review"],
];
type Session = {
  authenticated: boolean;
  localDevelopment: boolean;
  configured: boolean;
  email?: string;
};
export default function App() {
  const [session, setSession] = useState<Session>();
  const [state, setState] = useState<Snapshot>();
  const latest = useRef<Snapshot | undefined>(undefined);
  const [path, setPath] = useState(location.hash.slice(2) || "today");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [pending, setPending] = useState(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const initialized = useRef(false);
  const navigate = useCallback((next: string) => {
    location.hash = `/${next}`;
    setPath(next);
  }, []);
  const refresh = useCallback(async () => {
    const next = await request<Snapshot>("/api/state");
    latest.current = next;
    setState(next);
    return next;
  }, []);
  useEffect(() => {
    const handler = () => {
      setPath(location.hash.slice(2) || "today");
      setModal(null);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    let cancelled = false;
    request<Session>("/api/session")
      .then(async (value) => {
        if (cancelled) return;
        setSession(value);
        if (value.authenticated) {
          const next = await refresh();
          if (
            !initialized.current &&
            !next.setupSkipped &&
            !next.connections.some(
              (c) => c.role === "personal" && c.status === "connected",
            ) &&
            !location.hash
          )
            navigate("setup");
          initialized.current = true;
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [refresh, navigate]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const focus = () => safe(refresh());
    const timer = window.setInterval(focus, 300000);
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [session?.authenticated, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(timer);
  }, [toast]);
  const command = useCallback(
    (
      name: string,
      args: Record<string, unknown> = {},
      quiet = false,
    ): Promise<any> => {
      setPending((n) => n + 1);
      const run = chain.current
        .catch(() => undefined)
        .then(async () => {
          setError("");
          try {
            const body = JSON.stringify({
              ...args,
              expectedVersions: {
                ...latest.current?.versions,
                ...(args.expectedVersions as
                  Record<string, string> | undefined),
              },
              idempotencyKey: crypto.randomUUID(),
            });
            const send = () =>
              request<any>(`/api/commands/${name}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Organizer-Request": "1",
                },
                body,
              });
            let result;
            try {
              result = await send();
            } catch (e) {
              if (e instanceof TypeError) result = await send();
              else throw e;
            }
            await refresh();
            const receipt = result.data ?? result;
            if (!quiet)
              setToast(
                typeof receipt.summary === "string"
                  ? receipt.summary
                  : receipt.syncStatus === "pending"
                    ? "Saved in Organizer. Google Calendar synchronization is pending."
                    : "Saved.",
              );
            return result;
          } catch (e) {
            const failure = e as ApiError;
            setError(failure.message);
            if (
              failure.code === "VERSION_CONFLICT" ||
              failure instanceof TypeError
            )
              await refresh().catch(() => undefined);
            throw e;
          } finally {
            setPending((n) => Math.max(0, n - 1));
          }
        });
      chain.current = run;
      return run;
    },
    [refresh],
  );
  if (!session || (session.authenticated && !state))
    return (
      <div className="loading-screen">
        <div className="brand">
          <span className="brand-mark">O</span>Organizer
        </div>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button onClick={() => location.reload()}>Try again</Button>
          </>
        ) : (
          <p>Opening your places…</p>
        )}
      </div>
    );
  if (!session.authenticated)
    return (
      <div className="login-screen">
        <div className="brand">
          <span className="brand-mark">O</span>Organizer
        </div>
        <h1>One place at a time.</h1>
        <p>
          Four areas. One project and one book at each.
          <br />
          Make room for the work that matters.
        </p>
        {session.configured ? (
          <a className="button primary" href="/auth/login">
            Sign in with Google
          </a>
        ) : (
          <p role="status">Owner sign-in is not configured yet.</p>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </div>
    );
  const snapshot = state!;
  const section = path.split("/")[0];
  const active =
    section === "project"
      ? "board"
      : section === "book"
        ? "bookshelf"
        : section;
  const navIcon = (id: string) =>
    id === "today"
      ? active === id
        ? "today"
        : "today-inactive"
      : active === id
        ? `${id}-active`
        : id;
  const archivedCount = snapshot.items.filter(
    (i) => i.state === "paused" || i.state === "archived",
  ).length;
  const openItem = (item: Snapshot["items"][number]) =>
    navigate(
      item.kind === "project" ? `project/${item.id}` : `bookshelf/${item.id}`,
    );
  const start = (item: Snapshot["items"][number]) => {
    const current = snapshot.items.find(
      (i) =>
        i.state === "active" &&
        i.areaId === item.areaId &&
        i.kind === item.kind,
    );
    if (current) setModal({ type: "swap", item, current });
    else safe(command("start_item", { itemId: item.id }));
  };
  return (
    <AppContext.Provider
      value={{
        state: snapshot,
        command,
        refresh,
        busy: pending > 0,
        navigate,
        setModal,
        start,
        openItem,
        notify: setToast,
      }}
    >
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      {section !== "setup" && (
        <>
          <aside className="rail">
            <a href="#/today" className="brand">
              <span className="brand-mark">O</span>Organizer
            </a>
            <nav aria-label="Main">
              {nav.map(([id, label]) => (
                <a
                  key={id}
                  href={`#/${id}`}
                  className={active === id ? "active" : ""}
                  aria-current={active === id ? "page" : undefined}
                >
                  <Icon name={navIcon(id)} />
                  <span>{label}</span>
                </a>
              ))}
              <button onClick={() => setModal({ type: "drawer" })}>
                <Icon name="archive" />
                <span>Paused & archived</span>
                <span className="nav-count">{archivedCount}</span>
              </button>
            </nav>
            <div className="rail-bottom">
              <a href="#/settings">
                <span className="calendar-key personal" />
                Personal ·{" "}
                {snapshot.connections.find((c) => c.role === "personal")
                  ?.status === "connected"
                  ? "can book"
                  : "connect"}
              </a>
              <a href="#/settings">
                <span className="calendar-key work" />
                Work · read-only
              </a>
              <a className="settings-link" href="#/settings">
                Account & agents <span aria-hidden="true">↗</span>
              </a>
            </div>
          </aside>
          <header className="mobile-header">
            <a href="#/today" className="brand">
              <span className="brand-mark">O</span>Organizer
            </a>
            <a
              href="#/settings"
              className="mobile-settings"
              aria-label="Account and agent settings"
            >
              Settings
            </a>
          </header>
          <nav className="mobile-tabs" aria-label="Main">
            {nav.map(([id, label]) => (
              <a
                key={id}
                href={`#/${id}`}
                className={active === id ? "active" : ""}
                aria-current={active === id ? "page" : undefined}
              >
                <Icon name={navIcon(id)} />
                <span>
                  {id === "review"
                    ? "Review"
                    : id === "bookshelf"
                      ? "Shelf"
                      : label}
                </span>
              </a>
            ))}
          </nav>
        </>
      )}
      <main
        id="main"
        tabIndex={-1}
        className={section === "setup" ? "setup-main" : "main"}
      >
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        {section === "today" && <Today />}
        {section === "board" && <Board />}
        {section === "project" && <Project id={path.split("/")[1]} />}
        {section === "calendar" && <Calendar />}
        {section === "bookshelf" && (
          <Bookshelf selectedId={path.split("/")[1]} />
        )}
        {section === "review" && <ReviewScreen key={snapshot.reviewDate} />}
        {section === "settings" && <Settings session={session} />}
        {section === "setup" && <Onboarding />}
        {![
          "today",
          "board",
          "project",
          "calendar",
          "bookshelf",
          "review",
          "settings",
          "setup",
        ].includes(section) && <Today />}
      </main>
      {modal?.type === "drawer" && <Drawer onClose={() => setModal(null)} />}
      {modal?.type === "add" && (
        <AddDialog {...modal} onClose={() => setModal(null)} />
      )}
      {modal?.type === "find" && (
        <FindBook {...modal} onClose={() => setModal(null)} />
      )}
      {modal?.type === "edit" && (
        <EditDialog item={modal.item} onClose={() => setModal(null)} />
      )}
      {modal?.type === "swap" && (
        <SwapDialog
          item={modal.item}
          current={modal.current}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "finish" && (
        <FinishDialog item={modal.item} onClose={() => setModal(null)} />
      )}
      {modal?.type === "book" && (
        <BookTime {...modal} onClose={() => setModal(null)} />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </AppContext.Provider>
  );
}
