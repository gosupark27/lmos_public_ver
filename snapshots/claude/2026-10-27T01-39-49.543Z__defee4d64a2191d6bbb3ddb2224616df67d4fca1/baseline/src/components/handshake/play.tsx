import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, BookOpen, Sun } from "lucide-react";
import { act, away, closeRoom, configure, createRoom, joinRoom, snapshot, start } from "@/game/room";
import { RESOURCES, type Intent, type Resource, type TableView, type Tier } from "@/game/view";
import {
  isSealedQuery,
  markRubric,
  rankLabel,
  readRating,
  recordGame,
  revealX,
} from "./rating";
import { audioReady, bell, chime, wake } from "./sound";

const SESSION = "handshake.session.v1";

type Session = { code: string; token: string };
type Saved = ReturnType<typeof readRating>;
type Verb = "sacrifice" | "trade" | "accuse" | "vouch" | "boundary" | "peek";

const TIERS: { id: Tier; label: string; note: string }[] = [
  { id: "novice", label: "Novice", note: "Five days" },
  { id: "intermediate", label: "Intermediate", note: "Seven days" },
  { id: "advanced", label: "Advanced", note: "Nine days" },
];

const primary =
  "min-h-11 w-full rounded-2xl bg-ember px-4 py-3 text-center font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember disabled:opacity-50";
const quiet =
  "min-h-11 w-full rounded-2xl border border-line bg-surface px-4 py-3 text-left text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember disabled:opacity-50";
const ghost =
  "min-h-11 rounded-2xl px-3 py-2 text-sm text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember";

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.code || !parsed.token) return null;
    return { code: parsed.code, token: parsed.token };
  } catch {
    return null;
  }
}

function storeSession(session: Session | null): void {
  if (!session) localStorage.removeItem(SESSION);
  else localStorage.setItem(SESSION, JSON.stringify(session));
}

export function HandshakeApp() {
  const createFn = useServerFn(createRoom);
  const joinFn = useServerFn(joinRoom);
  const snapFn = useServerFn(snapshot);
  const configFn = useServerFn(configure);
  const startFn = useServerFn(start);
  const actFn = useServerFn(act);
  const awayFn = useServerFn(away);
  const closeFn = useServerFn(closeRoom);

  const snapRef = useRef(snapFn);
  const actRef = useRef(actFn);
  snapRef.current = snapFn;
  actRef.current = actFn;

  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<TableView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [glow, setGlow] = useState(false);
  const [draft, setDraft] = useState("");
  const [askCode, setAskCode] = useState(false);
  const [tier, setTier] = useState<Tier>("novice");
  const [size, setSize] = useState(5);
  const [rating, setRating] = useState<Saved>(() => readRating());
  const [egg, setEgg] = useState(false);
  const [copied, setCopied] = useState(false);
  const [verb, setVerb] = useState<Verb | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [resource, setResource] = useState<Resource | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  const sunriseSent = useRef<string | null>(null);
  const prevHumans = useRef(0);
  const prevPhase = useRef<string | null>(null);

  useEffect(() => {
    setSession(readSession());
    setRating(readRating());
    setGlow(audioReady());
  }, []);

  useEffect(() => {
    if (!session) return;
    let stop = false;
    const pull = async () => {
      const res = await snapRef.current({ data: session });
      if (stop) return;
      if (!res.ok) {
        if (/no company|not in this company/i.test(res.error)) {
          storeSession(null);
          setSession(null);
          setView(null);
        }
        setError(res.error);
        return;
      }
      setError(null);
      setView(res.view);
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 1600);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [session]);

  useEffect(() => {
    if (!view) return;
    const humans = view.table.seats.filter((s) => !s.bot).length;
    if (view.table.phase === "lobby" && humans > prevHumans.current && prevHumans.current > 0) {
      chime(humans);
    }
    prevHumans.current = humans;
    if (prevPhase.current && prevPhase.current !== view.table.phase) {
      if (view.table.phase === "prodigal" || view.table.phase === "ended") bell();
    }
    prevPhase.current = view.table.phase;
  }, [view]);

  useEffect(() => {
    if (!view) return;
    const ended = view.table.phase === "ended" && view.table.outcome;
    const seen = view.table.phase === "prodigal" || view.table.seats.some((s) => s.caught);
    if (!ended && !seen) return;
    if (ended && view.table.outcome) recordGame(view.table.code, view.table.outcome.kind);
    if (seen) markRubric("prodigal");
    setRating(readRating());
  }, [view]);

  useEffect(() => {
    setVerb(null);
    setTarget(null);
    setResource(null);
  }, [view?.table.round, view?.table.phase]);

  const youSealed = view?.table.seats.some((s) => s.yours && s.sealed) ?? false;
  const phase = view?.table.phase;
  const round = view?.table.round;
  const code = view?.table.code;

  useEffect(() => {
    if (!session || phase !== "sunrise" || round == null || !code) return;
    if (youSealed) return;
    const key = `${code}:${round}`;
    if (sunriseSent.current === key) return;
    const token = session;
    const timer = window.setTimeout(() => {
      sunriseSent.current = key;
      void actRef.current({
        data: { ...token, round, intent: { kind: "sunrise" } },
      }).then((res) => {
        if (res.ok) setView(res.view);
      });
    }, 3400);
    return () => window.clearTimeout(timer);
  }, [session, phase, round, code, youSealed]);

  function poke(): void {
    wake();
    setGlow(true);
  }

  async function run(work: () => Promise<{ ok: boolean; error?: string; view?: TableView; token?: string }>): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const res = await work();
      if (!res.ok || !res.view) {
        setError(res.error ?? "The trail couldn't be reached.");
        return false;
      }
      if (res.token) {
        const next = { code: res.view.table.code, token: res.token };
        storeSession(next);
        setSession(next);
      }
      setView(res.view);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The trail couldn't be reached.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function send(intent: Intent): Promise<void> {
    if (!session || !view) return;
    poke();
    const ok = await run(() => actFn({ data: { ...session, round: view.table.round, intent } }));
    if (!ok) return;
    if (intent.kind === "still") setRating(markRubric("still"));
    if (intent.kind === "sacrifice") setRating(markRubric("gave"));
  }

  function forget(): void {
    storeSession(null);
    setSession(null);
    setView(null);
    setError(null);
    setVerb(null);
  }

  if (session && !view) {
    return (
      <main className="min-h-dvh bg-bg px-5 py-16 text-fg">
        <h1 className="font-display text-4xl">Handshake</h1>
        <p className="mt-4 text-muted">Finding the company…</p>
        {error ? <p className="mt-3 text-sm text-ember">{error}</p> : null}
        <button type="button" className={`${ghost} mt-6`} onClick={forget}>
          Leave
        </button>
      </main>
    );
  }

  if (!session || !view) {
    return (
      <Gate
        glow={glow}
        pending={pending}
        error={error}
        draft={draft}
        askCode={askCode}
        tier={tier}
        size={size}
        rating={rating}
        egg={egg}
        onPoke={poke}
        onDraft={setDraft}
        onAsk={setAskCode}
        onTier={setTier}
        onSize={setSize}
        onOpen={() => {
          poke();
          void run(() => createFn({ data: { tier, size } }));
        }}
        onJoin={() => {
          poke();
          if (isSealedQuery(draft)) {
            setRating(revealX());
            setEgg(true);
            return;
          }
          void run(() => joinFn({ data: { code: draft } }));
        }}
      />
    );
  }

  const you = view.table.seats.find((s) => s.yours);

  return (
    <main className="relative min-h-dvh overflow-x-hidden bg-bg text-fg">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56" style={skyStyle(view.table.tier, view.table.sky)} />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-lg flex-col px-4 py-6 lg:max-w-5xl lg:px-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.22em] text-muted uppercase">Handshake</p>
            <h1 className="font-display text-3xl leading-tight">
              {view.table.phase === "lobby" ? "Before the light" : (view.table.eventTitle ?? "The trail")}
            </h1>
          </div>
          <Mark saved={rating} />
        </header>
        <p className="sr-only" aria-live="polite">
          {error ?? view.table.eventTitle}
        </p>
        {error ? <p className="mt-3 text-sm text-ember">{error}</p> : null}

        {view.table.phase === "lobby" ? (
          <Lobby
            view={view}
            pending={pending}
            copied={copied}
            onCopy={() => {
              void navigator.clipboard?.writeText(view.table.code).then(() => setCopied(true)).catch(() => setCopied(false));
            }}
            onTier={(next) => {
              setTier(next);
              void run(() => configFn({ data: { ...session, tier: next, size: view.table.seats.length } }));
            }}
            onSize={(next) => {
              setSize(next);
              void run(() => configFn({ data: { ...session, tier: view.table.tier, size: next } }));
            }}
            onStart={() => void run(() => startFn({ data: session }))}
            onLeave={() => {
              void (async () => {
                if (view.table.youAreHost) await closeFn({ data: session });
                else await awayFn({ data: { ...session, away: true } });
                forget();
              })();
            }}
          />
        ) : null}

        {view.table.phase === "sunrise" ? (
          <Sunrise
            tier={view.table.tier}
            sealed={Boolean(you?.sealed)}
            waiting={view.table.waiting}
            onAck={() => void send({ kind: "sunrise" })}
          />
        ) : null}

        {view.table.phase === "founding" ? (
          <Founding
            view={view}
            pending={pending}
            onChoose={(line) => void send({ kind: "found", line })}
          />
        ) : null}

        {view.table.phase === "day" || view.table.phase === "prodigal" || view.table.phase === "ended" ? (
          <Trail
            view={view}
            pending={pending}
            verb={verb}
            target={target}
            resource={resource}
            ledgerOpen={ledgerOpen}
            rating={rating}
            onVerb={setVerb}
            onTarget={setTarget}
            onResource={setResource}
            onLedger={() => {
              setLedgerOpen((open) => !open);
              setRating(markRubric("ledger"));
            }}
            onSend={(intent) => void send(intent)}
            onBack={() => {
              if (resource || (target && verb !== "sacrifice")) {
                setResource(null);
                setTarget(null);
                return;
              }
              setVerb(null);
              setTarget(null);
              setResource(null);
            }}
            onAway={() => {
              if (!you) return;
              void run(() => awayFn({ data: { ...session, away: !you.bot } }));
            }}
            onLeave={() => {
              void (async () => {
                await awayFn({ data: { ...session, away: true } });
                forget();
              })();
            }}
          />
        ) : null}
      </div>
    </main>
  );
}

function skyStyle(tier: Tier, sky: number): { background: string; opacity: number } {
  if (sky > 0.72) {
    return {
      background:
        "linear-gradient(90deg, var(--color-ember), var(--color-apocalypse) 46%, var(--color-deep))",
      opacity: 0.5,
    };
  }
  const color = tier === "novice" ? "var(--color-novice)" : tier === "intermediate" ? "var(--color-trail)" : "var(--color-deep)";
  return { background: `linear-gradient(180deg, ${color}, transparent 78%)`, opacity: 0.42 };
}

function Mark({ saved }: { saved: Saved }) {
  return (
    <div className="text-right">
      <p className="font-display text-2xl leading-none text-ember">{rankLabel(saved.value)}</p>
      <p className="text-xs text-muted tabular-nums">{saved.value.toFixed(2)}</p>
      {saved.floorHits >= 2 ? <p className="text-xs text-muted">Master.</p> : null}
    </div>
  );
}

function Gate(props: {
  glow: boolean;
  pending: boolean;
  error: string | null;
  draft: string;
  askCode: boolean;
  tier: Tier;
  size: number;
  rating: Saved;
  egg: boolean;
  onPoke: () => void;
  onDraft: (value: string) => void;
  onAsk: (value: boolean) => void;
  onTier: (tier: Tier) => void;
  onSize: (size: number) => void;
  onOpen: () => void;
  onJoin: () => void;
}) {
  return (
    <main className="relative min-h-dvh overflow-x-hidden bg-bg text-fg" onPointerDown={props.onPoke}>
      <div className="flashlight pointer-events-none fixed inset-0 hidden md:block" ref={bindFlash} />
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-between px-5 py-8 safe-b">
        <header className="flex items-start justify-between">
          <Sun className="size-5 text-muted" aria-hidden="true" />
          <Mark saved={props.rating} />
        </header>
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="font-display text-5xl leading-none">Handshake</h1>
            <div className={`mt-4 h-px w-24 origin-left bg-ember transition-transform duration-700 ${props.glow ? "scale-x-100" : "scale-x-0"}`} />
            <p className="mt-4 max-w-sm text-pretty text-muted">
              A company crosses without names. Room codes only. Empty wagons are driven.
            </p>
          </div>
          {props.error ? <p className="text-sm text-ember">{props.error}</p> : null}
          {props.egg ? (
            <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
              X is sealed. It is not a room, and it is not a rank you climb.
            </p>
          ) : null}
          <div className="grid grid-cols-3 gap-2">
            {TIERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={props.tier === item.id}
                className={props.tier === item.id ? primary : quiet}
                onClick={() => props.onTier(item.id)}
              >
                <span className="block text-sm">{item.label}</span>
                <span className="block text-xs opacity-80">{item.note}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[4, 5, 6].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={props.size === n}
                className={props.size === n ? primary : quiet}
                onClick={() => props.onSize(n)}
              >
                {n} wagons
              </button>
            ))}
          </div>
          <button type="button" className={primary} disabled={props.pending} onClick={props.onOpen}>
            {props.pending ? "Opening…" : "Open a room"}
          </button>
          {props.askCode ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                props.onJoin();
              }}
            >
              <label className="text-sm text-muted" htmlFor="room-code">
                Room code
              </label>
              <input
                id="room-code"
                value={props.draft}
                onChange={(e) => props.onDraft(e.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={8}
                className="min-h-11 rounded-2xl border border-line bg-surface px-4 text-base tracking-[0.28em] text-fg uppercase outline-none focus-visible:outline-2 focus-visible:outline-ember"
              />
              <button type="submit" className={quiet} disabled={props.pending || props.draft.trim().length < 1}>
                Enter
              </button>
            </form>
          ) : (
            <button type="button" className={quiet} onClick={() => props.onAsk(true)}>
              I have a code
            </button>
          )}
        </div>
        <Rubric saved={props.rating} />
      </div>
    </main>
  );
}

function bindFlash(node: HTMLDivElement | null): void {
  if (!node || node.dataset.bound === "1") return;
  node.dataset.bound = "1";
  window.addEventListener("pointermove", (event) => {
    node.style.setProperty("--fx", `${event.clientX}px`);
    node.style.setProperty("--fy", `${event.clientY}px`);
  });
}

function Rubric({ saved }: { saved: Saved }) {
  const items: { label: string; on: boolean; hidden?: boolean }[] = [
    { label: "Give something without a bargain", on: saved.rubric.gave },
    { label: "Stay still once", on: saved.rubric.still },
  ];
  if (saved.rubric.ledger) items.push({ label: "Read the ledger through", on: true });
  if (saved.rubric.prodigal) items.push({ label: "See the room stop pretending", on: true });
  return (
    <ul className="mt-8 flex flex-col gap-1 text-sm text-muted">
      {items.map((item) => (
        <li key={item.label}>
          {item.on ? "Done · " : "· "}
          {item.label}
        </li>
      ))}
      {saved.foundX ? <li className="text-ember">X — sealed</li> : <li>X stays sealed</li>}
    </ul>
  );
}

function Lobby(props: {
  view: TableView;
  pending: boolean;
  copied: boolean;
  onCopy: () => void;
  onTier: (tier: Tier) => void;
  onSize: (size: number) => void;
  onStart: () => void;
  onLeave: () => void;
}) {
  const { table } = props.view;
  return (
    <section className="mt-8 flex flex-1 flex-col gap-6 safe-b">
      <button type="button" onClick={props.onCopy} className="text-left">
        <p className="text-sm text-muted">Room code</p>
        <p className="font-display text-5xl tracking-[0.18em]">{table.code}</p>
        <p className="text-sm text-muted">{props.copied ? "Copied" : "Tap to copy. Read it to the next wagon."}</p>
      </button>
      <p className="max-w-md text-pretty text-muted">
        Four gifts, given freely, end the crossing. Heat simmers. It does not flash. A second phone can take an empty wagon.
      </p>
      {table.youAreHost ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            {TIERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={table.tier === item.id}
                className={table.tier === item.id ? primary : quiet}
                onClick={() => props.onTier(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[4, 5, 6].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={table.seats.length === n}
                className={table.seats.length === n ? primary : quiet}
                onClick={() => props.onSize(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <button type="button" className={primary} disabled={props.pending} onClick={props.onStart}>
            Start when the light is ready
          </button>
        </>
      ) : (
        <p className="text-muted">Waiting on the host. {TIERS.find((t) => t.id === table.tier)?.label}. {table.seats.length} wagons.</p>
      )}
      <SeatList seats={table.seats} picking={false} onPick={() => undefined} />
      <button type="button" className={ghost} onClick={props.onLeave}>
        {table.youAreHost ? "Close the room" : "Leave the code"}
      </button>
    </section>
  );
}

function Sunrise(props: { tier: Tier; sealed: boolean; waiting: number; onAck: () => void }) {
  const wash = props.tier === "novice" ? "var(--color-novice)" : props.tier === "intermediate" ? "var(--color-trail)" : "var(--color-deep)";
  return (
    <section className="mt-10 flex flex-1 flex-col justify-end gap-6 safe-b">
      <div className="h-40 rounded-3xl" style={{ background: `linear-gradient(180deg, ${wash}, transparent)` }} />
      <p className="font-display text-2xl">Nobody speaks.</p>
      <p className="text-muted">The light comes the way it does on the highway west.</p>
      {props.sealed ? (
        <p className="text-sm text-muted">Waiting on {props.waiting}.</p>
      ) : (
        <button type="button" className={primary} onClick={props.onAck}>
          The light is up
        </button>
      )}
    </section>
  );
}

function Founding(props: { view: TableView; pending: boolean; onChoose: (line: string) => void }) {
  const you = props.view.table.seats.find((s) => s.yours);
  const lines = props.view.hand.lines ?? [];
  return (
    <section className="mt-8 flex flex-col gap-4 safe-b">
      <p className="text-pretty text-muted">{props.view.table.eventBody}</p>
      {you?.sealed ? (
        <p>Your sentence is in. Waiting on {props.view.table.waiting}.</p>
      ) : (
        lines.map((line) => (
          <button key={line.id} type="button" className={quiet} disabled={props.pending} onClick={() => props.onChoose(line.id)}>
            {line.text}
          </button>
        ))
      )}
      <SeatList seats={props.view.table.seats} picking={false} onPick={() => undefined} />
    </section>
  );
}

function Trail(props: {
  view: TableView;
  pending: boolean;
  verb: Verb | null;
  target: string | null;
  resource: Resource | null;
  ledgerOpen: boolean;
  rating: Saved;
  onVerb: (verb: Verb | null) => void;
  onTarget: (id: string) => void;
  onResource: (resource: Resource) => void;
  onLedger: () => void;
  onSend: (intent: Intent) => void;
  onBack: () => void;
  onAway: () => void;
  onLeave: () => void;
}) {
  const { table, hand } = props.view;
  const you = table.seats.find((s) => s.yours);
  const gifts = table.seats.filter((s) => s.sacrificed).length;
  const yours = table.prodigalSeatId === hand.seatId;
  const prodigal = table.seats.find((s) => s.id === table.prodigalSeatId);

  return (
    <div className="mt-6 grid flex-1 gap-6 lg:grid-cols-[1.15fr_0.85fr] safe-b">
      <section className="flex flex-col gap-4">
        {table.phase !== "ended" ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between text-sm text-muted">
              <span className="tabular-nums">Day {table.day} / {table.dayCount}</span>
              <span className="tabular-nums">Gifts {gifts} / 4</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label="Heat" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(table.heat)}>
              <div className="h-full rounded-full bg-ember transition-all duration-700" style={{ width: `${table.heat}%` }} />
            </div>
            <p className="text-xs text-muted">Heat simmers. Miles {table.miles}.</p>
            {table.sky > 0.55 ? <p className="text-sm">The sky is splitting.</p> : null}
          </div>
        ) : null}

        {table.phase === "ended" && table.outcome ? (
          <div className="flex flex-col gap-3">
            <p className="text-pretty">{table.outcome.text}</p>
            {hand.mirror ? (
              <p className="rounded-2xl border border-line bg-surface px-4 py-3 font-display text-xl">{hand.mirror}</p>
            ) : null}
          </div>
        ) : null}

        {table.phase === "prodigal" ? (
          <div className="flex flex-col gap-3">
            <p className="font-display text-2xl">The table is frozen.</p>
            {yours ? (
              <>
                <p>They stopped pretending. Speak, or don't.</p>
                <button type="button" className={primary} disabled={props.pending} onClick={() => props.onSend({ kind: "confess" })}>
                  Say it out loud
                </button>
                <button type="button" className={quiet} disabled={props.pending} onClick={() => props.onSend({ kind: "quiet" })}>
                  Stay silent
                </button>
              </>
            ) : (
              <p className="text-muted">The company is waiting on {prodigal?.name ?? "one voice"}.</p>
            )}
          </div>
        ) : null}

        {table.phase === "day" ? (
          <>
            <p className="text-pretty text-muted">{table.eventBody}</p>
            <YourWagon view={props.view} />
            {you?.bot ? <p className="text-sm text-muted">A hand is driving your wagon.</p> : null}
            {you?.sealed ? (
              <p>Sealed. The day turns when every held wagon has spoken. Waiting on {table.waiting}.</p>
            ) : you?.bot ? null : (
              <Composer {...props} />
            )}
          </>
        ) : null}

        <div className="flex gap-2">
          {table.phase !== "ended" ? (
            <button type="button" className={ghost} onClick={props.onAway}>
              {you?.bot ? "Take the wagon back" : "Let a hand drive"}
            </button>
          ) : null}
          <button type="button" className={ghost} onClick={props.onLeave}>
            Leave
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SeatList seats={table.seats} picking={false} onPick={() => undefined} />
        <button type="button" className={`${quiet} inline-flex items-center gap-2`} onClick={props.onLedger}>
          <BookOpen className="size-4" aria-hidden="true" />
          Ledger
        </button>
        {props.ledgerOpen ? <Ledger view={props.view} /> : null}
        {table.phase === "ended" ? <Rubric saved={props.rating} /> : null}
      </section>
    </div>
  );
}

function YourWagon({ view }: { view: TableView }) {
  const you = view.table.seats.find((s) => s.yours);
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="font-display text-2xl">{you?.name}</p>
      <p className="text-sm text-muted">{you?.archetype}</p>
      <p className="mt-1 text-sm text-pretty text-muted">{you?.trait}</p>
      <div className="mt-4 grid grid-cols-4 gap-2">
        {RESOURCES.map((item) => (
          <div key={item} className="rounded-xl bg-surface-2 px-2 py-2 text-center">
            <p className="text-xs text-muted capitalize">{item}</p>
            <p className="text-lg tabular-nums">{view.hand.pack[item]}</p>
          </div>
        ))}
      </div>
      {view.hand.warning ? <p className="mt-3 text-sm text-ember">{view.hand.warning}</p> : null}
      {view.hand.peek ? (
        <p className="mt-3 text-sm">
          You looked at {view.hand.peek.name}. {view.hand.peek.note}
        </p>
      ) : null}
    </div>
  );
}

function Composer(props: {
  view: TableView;
  pending: boolean;
  verb: Verb | null;
  target: string | null;
  resource: Resource | null;
  onVerb: (verb: Verb | null) => void;
  onTarget: (id: string) => void;
  onResource: (resource: Resource) => void;
  onSend: (intent: Intent) => void;
  onBack: () => void;
}) {
  const targetSeat = props.view.table.seats.find((s) => s.id === props.target);
  const verbs: { id: Verb; label: string; note: string }[] = [
    { id: "sacrifice", label: "Give to the crossing", note: "A gift. It is not a bargain." },
    { id: "trade", label: "Trade", note: "Both names go in the ledger." },
    { id: "accuse", label: "Name someone", note: "A majority has to agree." },
    { id: "vouch", label: "Speak softly", note: "A soft word shifts the room." },
    { id: "boundary", label: "Draw a line", note: "Who counts as inside today." },
    { id: "peek", label: "Look where no one is", note: "Only you will hear it." },
  ];

  if (!props.verb) {
    return (
      <div className="flex flex-col gap-2">
        {verbs.map((item) => (
          <button key={item.id} type="button" className={quiet} onClick={() => props.onVerb(item.id)}>
            <span className="block">{item.label}</span>
            <span className="block text-sm text-muted">{item.note}</span>
          </button>
        ))}
        <button type="button" className={primary} disabled={props.pending} onClick={() => props.onSend({ kind: "still" })}>
          Stay still
        </button>
      </div>
    );
  }

  if (props.verb !== "sacrifice" && !props.target) {
    return (
      <div className="flex flex-col gap-2">
        <button type="button" className={`${ghost} inline-flex items-center gap-2`} onClick={props.onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" /> Back
        </button>
        <p className="text-sm text-muted">Choose a wagon.</p>
        <SeatList seats={props.view.table.seats.filter((s) => !s.yours)} picking onPick={props.onTarget} />
      </div>
    );
  }

  const needsResource = props.verb === "sacrifice" || props.verb === "trade";
  if (needsResource && !props.resource) {
    return (
      <div className="flex flex-col gap-2">
        <button type="button" className={`${ghost} inline-flex items-center gap-2`} onClick={props.onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" /> Back
        </button>
        {RESOURCES.map((item) => (
          <button
            key={item}
            type="button"
            className={quiet}
            disabled={props.view.hand.pack[item] <= 0}
            onClick={() => props.onResource(item)}
          >
            <span className="capitalize">{item}</span>
            <span className="ml-2 text-muted tabular-nums">{props.view.hand.pack[item]}</span>
          </button>
        ))}
      </div>
    );
  }

  const sentence =
    props.verb === "sacrifice"
      ? `Give ${props.resource} to the crossing.`
      : props.verb === "trade"
        ? `Pass ${props.resource} to ${targetSeat?.name}.`
        : props.verb === "accuse"
          ? `Name ${targetSeat?.name}.`
          : props.verb === "vouch"
            ? `Speak for ${targetSeat?.name}.`
            : props.verb === "boundary"
              ? `Draw ${targetSeat?.name} outside.`
              : `Look into ${targetSeat?.name}'s wagon.`;

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={`${ghost} inline-flex items-center gap-2`} onClick={props.onBack}>
        <ArrowLeft className="size-4" aria-hidden="true" /> Back
      </button>
      <p className="font-display text-2xl">{sentence}</p>
      <button
        type="button"
        className={primary}
        disabled={props.pending}
        onClick={() => {
          const verb = props.verb;
          if (!verb) return;
          if (verb === "sacrifice" && props.resource) props.onSend({ kind: "sacrifice", resource: props.resource });
          else if (verb === "trade" && props.resource && props.target) {
            props.onSend({ kind: "trade", to: props.target, resource: props.resource });
          } else if (props.target && (verb === "accuse" || verb === "vouch" || verb === "boundary" || verb === "peek")) {
            props.onSend({ kind: verb, target: props.target });
          }
        }}
      >
        Seal it
      </button>
    </div>
  );
}

function SeatList(props: {
  seats: TableView["table"]["seats"];
  picking: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {props.seats.map((seat) => {
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{seat.name}</span>
              <span className="text-xs text-muted tabular-nums">wt {seat.weight}</span>
            </div>
            <p className="text-xs text-muted">
              {seat.yours ? "You" : seat.bot ? "A hand" : "Held"}
              {seat.leading ? " · holds the reins" : ""}
              {seat.outside ? " · outside" : ""}
              {seat.caught ? " · seen" : ""}
              {seat.sacrificed ? " · gave" : ""}
              {seat.sealed ? " · sealed" : ""}
            </p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <div className="h-full bg-fg/70" style={{ width: `${seat.presence}%` }} />
            </div>
            <p className="sr-only">Still water {seat.presence > 66 ? "high" : seat.presence > 33 ? "middling" : "quiet"}</p>
          </>
        );
        return (
          <li key={seat.id}>
            {props.picking ? (
              <button type="button" className={`${quiet} w-full`} onClick={() => props.onPick(seat.id)}>
                {body}
              </button>
            ) : (
              <article className="rounded-2xl border border-line bg-surface px-4 py-3">{body}</article>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Ledger({ view }: { view: TableView }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [view.table.ledger.length]);
  return (
    <div className="max-h-80 overflow-y-auto rounded-2xl border border-line bg-surface px-4 py-3">
      <ol className="flex flex-col gap-3">
        {view.table.ledger.map((line) => (
          <li key={line.id}>
            <p className="text-xs text-muted tabular-nums">Day {line.day}</p>
            <p className="text-pretty">{line.text}</p>
          </li>
        ))}
      </ol>
      <div ref={end} />
    </div>
  );
}
