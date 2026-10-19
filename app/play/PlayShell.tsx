"use client";
// The client-only boundary: the game touches WebGL, WebSocket, pointer lock,
// AudioContext and localStorage, so it's loaded with ssr: false from inside a Client
// Component, as the Next.js lazy-loading guide requires.
import dynamic from "next/dynamic";
import { useEffect, useState, type FormEvent } from "react";

const Game = dynamic(() => import("../../client/Game.tsx"), {
  ssr: false,
  loading: () => (
    <main className="loading">
      <h1>Loading the map…</h1>
    </main>
  ),
});

export default function PlayShell() {
  const [room, setRoom] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const r = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
    setRoom(/^[A-Z0-9]{5}$/.test(r) ? r : "");
    setName(localStorage.getItem("kiln:name"));
  }, []);

  if (room === null)
    return (
      <main className="loading">
        <h1>Loading…</h1>
      </main>
    );
  if (!room)
    return (
      <main className="landing">
        <div className="card">
          <p>That link has no room in it.</p>
          <a href="/">Start or join a room</a>
        </div>
      </main>
    );
  if (!name)
    return (
      <main className="landing">
        <form
          className="card"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const n = draft.trim() || "Player";
            localStorage.setItem("kiln:name", n);
            setName(n);
          }}
        >
          <h1>Joining room {room}</h1>
          <label>
            Your name <input autoFocus maxLength={16} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <button type="submit">Join</button>
        </form>
      </main>
    );
  return <Game room={room} name={name} />;
}
