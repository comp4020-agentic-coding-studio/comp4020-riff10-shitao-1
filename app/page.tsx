"use client";
import { useEffect, useState, type FormEvent } from "react";

export default function Home() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setName(localStorage.getItem("kiln:name") ?? ""), []);

  const remember = (): string => {
    const n = name.trim() || "Player";
    localStorage.setItem("kiln:name", n);
    return n;
  };

  async function create(bots: number): Promise<void> {
    remember();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bots }) });
      if (!res.ok) throw new Error(String(res.status));
      const { code } = (await res.json()) as { code: string };
      location.href = `/play/?room=${code}`;
    } catch {
      setError("Couldn't reach the server. Try again in a moment.");
      setBusy(false);
    }
  }

  function join(e: FormEvent): void {
    e.preventDefault();
    remember();
    const c = code.trim().toUpperCase();
    if (/^[A-Z0-9]{5}$/.test(c)) location.href = `/play/?room=${c}`;
    else setError("A room code is five letters and numbers.");
  }

  return (
    <main className="landing">
      <div className="card hero">
        <h1>Kiln</h1>
        <p className="lede">
          A small round-based tactical shooter in your browser. Two sides of up to five. Terrorists carry a bomb to site A or B and defend the plant;
          counter-terrorists stop them or defuse it. Buy between rounds, win seven rounds, swap sides at the half. One map, a handful of guns, and a
          server that decides every shot.
        </p>
        <label>
          Your name <input value={name} maxLength={16} onChange={(e) => setName(e.target.value)} placeholder="Player" />
        </label>
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void create(0)}>
            Start a room for friends
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void create(4)}>
            Start a room with bots (practice)
          </button>
        </div>
        <form onSubmit={join} className="row">
          <label>
            Room code <input value={code} maxLength={5} onChange={(e) => setCode(e.target.value)} placeholder="ABC23" autoCapitalize="characters" />
          </label>
          <button type="submit">Join a room</button>
        </form>
        {error && <p role="alert" className="bad">{error}</p>}
        <p className="small">
          Up to ten players, no account or install. Needs a desktop browser with a mouse and keyboard. <a href="/readme/">How to play, and how it works</a>
        </p>
      </div>
    </main>
  );
}
