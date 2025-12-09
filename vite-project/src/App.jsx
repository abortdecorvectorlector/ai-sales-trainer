// src/App.jsx
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";

const API_BASE =
  import.meta.env.VITE_API_BASE || "http://localhost:5000";

const isMobile =
  typeof navigator !== "undefined" &&
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );


console.log("API_BASE in browser:", API_BASE);
  
function App() {
  const [conversation, setConversation] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // sim / scoring / state
  const [decision, setDecision] = useState(null);
  const [debugState, setDebugState] = useState(null);
  const [score, setScore] = useState(null);
  const [coachTips, setCoachTips] = useState(null);
  const [simStarted, setSimStarted] = useState(false);
  const [error, setError] = useState(null);

  // hint / coach
  const [hint, setHint] = useState("");
  const [hintLoading, setHintLoading] = useState(false);

  // STT / TTS
  const [sttSupported, setSttSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [autoSpeak] = useState(!isMobile);
  const [ttsReady, setTtsReady] = useState(false);
  const recognitionRef = useRef(null);


  // ---- helper: build history payload for /api/simulate ----
  const buildHistory = useCallback(() => {
    return conversation
      .filter((m) => m.role === "rep" || m.role === "customer")
      .map((m) => ({ role: m.role, text: m.text }));
  }, [conversation]);

  // ---- helper: send line to backend (rep -> customer) ----
 const sendToBackend = useCallback(
  async (repLine) => {
    setLoading(true);
    try {
      const history = buildHistory();

      // Build conversation array for the backend that expects it
      // We take the existing history and append the current rep line
      const conversationPayload = [
        ...history,
        { role: "rep", text: repLine },
      ];

      const res = await fetch(`${API_BASE}/api/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: "solar + battery program",
          customerType: "mixed",
          objection: "",
          difficulty: "normal",
          pitch: repLine,
          history,              // for the new prompt builder
          conversation: conversationPayload, // for the old backend expectation
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to get sim response");
      }

      const data = await res.json();
      const { reply, score: scores, tips, state } = data;

      // append customer reply
      setConversation((prev) => [
        ...prev,
        { role: "customer", text: reply },
      ]);

      setDecision(state?.latest_decision || null);
      setDebugState(state || null);
      setScore(scores || null);
      setCoachTips(tips || null);

  if (autoSpeak && ttsReady && "speechSynthesis" in window) {
    try {
      const utter = new SpeechSynthesisUtterance(reply);
      utter.rate = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } catch (e) {
      console.error("TTS speak failed:", e);
    }
  }
} catch (err) {
  console.error("Error in /api/simulate:", err);
  setError(err.message || "Error talking to simulator");
} finally {
  setLoading(false);
}
  },
  [autoSpeak, buildHistory, ttsReady]
);

  // ---- helper: handle send (text OR STT transcript) ----
  const handleSend = useCallback(
    async (textOverride) => {
      const content = (textOverride ?? input).trim();
      if (!content || loading) return;

      if (!simStarted) {
        setError("Simulation has not started yet.");
        return;
      }

      setInput("");
      setError(null);
      setHint(""); // clear previous hint when you take action

      // add rep line
      setConversation((prev) => [
        ...prev,
        { role: "rep", text: content },
      ]);

      await sendToBackend(content);
    },
    [input, loading, simStarted, sendToBackend]
  );

  // ---- start sim on mount (local only, stateless backend) ----
  useEffect(() => {
    setSimStarted(true);
    setConversation([
      {
        role: "system",
        text: "Simulation started. New homeowner, fresh objections. Practice your opener and work to a small yes or appointment.",
      },
    ]);
  }, []);

  // ---- init STT once, using handleSend as dependency ----
  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSttSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);

    recognition.onerror = (event) => {
      console.error("STT error:", event);
      setError("Speech recognition error. Try again or use typing.");
      setIsListening(false);
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      if (transcript) {
        // push transcript through same path
        handleSend(transcript);
      }
    };

    recognitionRef.current = recognition;
    setSttSupported(true);

    return () => {
      recognitionRef.current = null;
    };
  }, [handleSend]);

  const handleClickSend = () => handleSend();

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleListening = () => {
    if (!sttSupported || !recognitionRef.current || loading || !simStarted) {
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
    } else {
      setError(null);
      recognitionRef.current.start();
    }
  };

  const handleRestart = () => {
    setConversation([
      {
        role: "system",
        text: "Simulation restarted. New homeowner, new backstory. Start again from your opener.",
      },
    ]);
    setDecision(null);
    setDebugState(null);
    setScore(null);
    setCoachTips(null);
    setHint("");
    setError(null);
    setSimStarted(true);

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  };

  // ---- Hint / Coach endpoint ----
  const handleHintClick = async () => {
    if (!conversation.length) {
      setHint("Say your first line to get a useful hint.");
      return;
    }

    setHintLoading(true);
    setError(null);

    try {
      const transcript = conversation
        .filter((m) => m.role !== "system")
        .map((m) =>
          `${m.role === "rep" ? "You" : "Customer"}: ${m.text}`
        )
        .join("\n");

      const simState = debugState?.latest_decision || "in_play";
      const flags = debugState || {};

      const res = await fetch(`${API_BASE}/api/hint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simState,
          flags,
          transcript,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to get hint");
      }

      const data = await res.json();
      setHint(data.hint || "No hint available yet.");
    } catch (err) {
      console.error("Error in /api/hint:", err);
      setError(err.message || "Error getting coaching hint");
    } finally {
      setHintLoading(false);
    }
  };

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        minHeight: "100vh",
        margin: 0,
        padding: "1.5rem",
        backgroundColor: "#0f172a",
        color: "#e5e7eb",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.5rem", margin: 0 }}>
            AI Sales Trainer · MVP
          </h1>
          <p
            style={{
              fontSize: "0.9rem",
              marginTop: "0.25rem",
              color: "#9ca3af",
            }}
          >
            Practice live objections with voice · You vs Customer
          </p>
        </div>
        <button
          onClick={handleRestart}
          style={{
            padding: "0.4rem 0.9rem",
            borderRadius: "0.375rem",
            border: "1px solid #4b5563",
            background: "#111827",
            color: "#e5e7eb",
            fontSize: "0.85rem",
            cursor: "pointer",
          }}
        >
          Restart Simulation
        </button>
      </header>

      {error && (
        <div
          style={{
            backgroundColor: "#7f1d1d",
            padding: "0.5rem 0.75rem",
            borderRadius: "0.375rem",
            fontSize: "0.85rem",
          }}
        >
          Error: {error}
        </div>
      )}

      <main
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: "1rem",
          alignItems: "stretch",
        }}
      >
        {/* LEFT: convo + mic */}
        <section
          style={{
            backgroundColor: "#020617",
            borderRadius: "0.75rem",
            padding: "1rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            border: "1px solid #1f2937",
            minHeight: "50vh",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "0.25rem",
              fontSize: "0.8rem",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "#9ca3af",
            }}
          >
            <span>Me (Rep)</span>
            <span>Customer</span>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: "auto",
              paddingRight: "0.25rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {conversation.map((turn, idx) => (
              <div
                key={idx}
                style={{
                  alignSelf:
                    turn.role === "rep"
                      ? "flex-start"
                      : turn.role === "customer"
                      ? "flex-end"
                      : "center",
                  maxWidth: "80%",
                  fontSize: "0.9rem",
                }}
              >
                <div
                  style={{
                    padding: "0.5rem 0.75rem",
                    borderRadius:
                      turn.role === "rep"
                        ? "0.75rem 0.75rem 0.75rem 0"
                        : turn.role === "customer"
                        ? "0.75rem 0.75rem 0 0.75rem"
                        : "0.5rem",
                    backgroundColor:
                      turn.role === "rep"
                        ? "#1d4ed8"
                        : turn.role === "customer"
                        ? "#111827"
                        : "transparent",
                    border:
                      turn.role === "system" ? "1px dashed #4b5563" : "none",
                    color:
                      turn.role === "rep" || turn.role === "customer"
                        ? "#e5e7eb"
                        : "#9ca3af",
                  }}
                >
                  {turn.role !== "system" && (
                    <div
                      style={{
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        marginBottom: "0.25rem",
                        color: "#9ca3af",
                      }}
                    >
                      {turn.role === "rep" ? "You" : "Customer"}
                    </div>
                  )}
                  <div>{turn.text}</div>
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              borderTop: "1px solid #1f2937",
              paddingTop: "0.75rem",
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: "0.75rem",
              alignItems: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "flex-end",
              }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  simStarted
                    ? "Type your line or use the mic button..."
                    : "Starting simulation..."
                }
                disabled={!simStarted || loading}
                style={{
                  flex: 1,
                  minHeight: "3.2rem",
                  maxHeight: "6rem",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #374151",
                  backgroundColor: "#020617",
                  color: "#e5e7eb",
                  fontFamily: "inherit",
                  fontSize: "0.9rem",
                  resize: "vertical",
                }}
              />
              <button
                onClick={handleClickSend}
                disabled={!simStarted || loading || !input.trim()}
                style={{
                  padding: "0.6rem 1rem",
                  borderRadius: "0.5rem",
                  border: "none",
                  backgroundColor: loading ? "#1f2937" : "#22c55e",
                  color: "#020617",
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  cursor:
                    !simStarted || loading || !input.trim()
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    !simStarted || loading || !input.trim()
                      ? 0.6
                      : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {loading ? "Thinking..." : "Send"}
              </button>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "0.35rem",
              }}
            >
              <button
                onClick={toggleListening}
                disabled={!sttSupported || !simStarted || loading}
                style={{
                  width: "72px",
                  height: "72px",
                  borderRadius: "999px",
                  border: "none",
                  backgroundColor: !sttSupported
                    ? "#374151"
                    : isListening
                    ? "#ef4444"
                    : "#eab308",
                  color: "#020617",
                  fontWeight: 700,
                  fontSize: "0.75rem",
                  cursor:
                    !sttSupported || !simStarted || loading
                      ? "not-allowed"
                      : "pointer",
                  boxShadow: isListening
                    ? "0 0 0 4px rgba(239,68,68,0.4)"
                    : "0 0 0 2px rgba(234,179,8,0.3)",
                  transition: "transform 0.1s ease, box-shadow 0.1s ease",
                }}
              >
                {sttSupported
                  ? isListening
                    ? "Listening"
                    : "Talk"
                  : "No Mic"}
              </button>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>
                {sttSupported
                  ? isListening
                    ? "Speak your line…"
                    : "Tap to speak"
                  : "Browser doesn't support STT"}
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT: scorecard / debug / hint */}
        <section
          style={{
            backgroundColor: "#020617",
            borderRadius: "0.75rem",
            padding: "1rem",
            border: "1px solid #1f2937",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <h2 style={{ fontSize: "1rem", margin: 0, marginBottom: "0.5rem" }}>
            Scorecard / Sim State
          </h2>

          <div style={{ fontSize: "0.85rem", color: "#9ca3af" }}>
            <div style={{ marginBottom: "0.25rem" }}>
              <strong>Last decision:</strong>{" "}
              <span style={{ color: "#e5e7eb" }}>{decision || "—"}</span>
            </div>

            {score && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: "0.4rem",
                  marginTop: "0.5rem",
                  fontSize: "0.8rem",
                }}
              >
                <div>
                  <div style={{ color: "#9ca3af" }}>Cadence</div>
                  <div style={{ color: "#e5e7eb" }}>
                    {score.cadence ?? "—"}/10
                  </div>
                </div>
                <div>
                  <div style={{ color: "#9ca3af" }}>Clarity</div>
                  <div style={{ color: "#e5e7eb" }}>
                    {score.clarity ?? "—"}/10
                  </div>
                </div>
                <div>
                  <div style={{ color: "#9ca3af" }}>Objection Handling</div>
                  <div style={{ color: "#e5e7eb" }}>
                    {score.objection_handling ?? "—"}/10
                  </div>
                </div>
                <div>
                  <div style={{ color: "#9ca3af" }}>Overall</div>
                  <div style={{ color: "#e5e7eb" }}>
                    {score.overall ?? "—"}/10
                  </div>
                </div>
              </div>
            )}

<button
  type="button"
  onClick={() => {
    if (!("speechSynthesis" in window)) {
      alert("Your browser does not support text-to-speech.");
      return;
    }

    try {
      const testUtterance = new SpeechSynthesisUtterance(
        "Voice has been enabled for your sales trainer."
      );
      testUtterance.rate = 1;

      testUtterance.onend = () => {
        setTtsReady(true);
        console.log("TTS warmed up and ready.");
      };

      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(testUtterance);
    } catch (err) {
      console.error("TTS warmup failed:", err);
    }
  }}
  style={{
    marginTop: "0.4rem",
    padding: "0.25rem 0.6rem",
    borderRadius: "0.375rem",
    border: "1px solid #4b5563",
    backgroundColor: "#111827",
    color: "#e5e7eb",
    fontSize: "0.75rem",
    cursor: "pointer",
  }}
>
  {ttsReady ? "Voice ready" : "Tap to enable voice"}
</button>

            {coachTips && coachTips.length > 0 && (
              <div
                style={{
                  marginTop: "0.75rem",
                  padding: "0.5rem 0.75rem",
                  backgroundColor: "#020617",
                  borderRadius: "0.5rem",
                  border: "1px solid #111827",
                }}
              >
                <div
                  style={{
                    marginBottom: "0.25rem",
                    fontWeight: 600,
                    color: "#e5e7eb",
                  }}
                >
                  Coaching tips (next line)
                </div>
                <ul
                  style={{
                    paddingLeft: "1.1rem",
                    margin: 0,
                    fontSize: "0.8rem",
                  }}
                >
                  {coachTips.map((tip, idx) => (
                    <li key={idx}>{tip}</li>
                  ))}
                </ul>
              </div>
            )}

            <div
              style={{
                marginTop: "0.75rem",
                padding: "0.5rem 0.75rem",
                borderRadius: "0.5rem",
                border: "1px dashed #4b5563",
                backgroundColor: "#020617",
                display: "flex",
                flexDirection: "column",
                gap: "0.4rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <span
                  style={{
                    fontSize: "0.8rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    color: "#9ca3af",
                  }}
                >
                  Coach Hint
                </span>
                <button
                  onClick={handleHintClick}
                  disabled={hintLoading || !simStarted}
                  style={{
                    padding: "0.25rem 0.6rem",
                    borderRadius: "0.375rem",
                    border: "1px solid #4b5563",
                    backgroundColor: "#111827",
                    color: "#e5e7eb",
                    fontSize: "0.75rem",
                    cursor:
                      hintLoading || !simStarted ? "not-allowed" : "pointer",
                    opacity: hintLoading || !simStarted ? 0.6 : 1,
                  }}
                >
                  {hintLoading ? "Thinking..." : "Hint / Coach Me"}
                </button>
              </div>
              <div
                style={{
                  fontSize: "0.8rem",
                  color: hint ? "#e5e7eb" : "#6b7280",
                  whiteSpace: "pre-wrap",
                }}
              >
                {hint || "Hit the button if you feel stuck on your next line."}
              </div>
            </div>

            {debugState && (
              <div
                style={{
                  marginTop: "0.75rem",
                  padding: "0.5rem 0.75rem",
                  backgroundColor: "#020617",
                  borderRadius: "0.5rem",
                  border: "1px solid #111827",
                  maxHeight: "220px",
                  overflowY: "auto",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                }}
              >
                <div style={{ marginBottom: "0.25rem", fontWeight: 600 }}>
                  Internal State (debug)
                </div>
                <pre
                  style={{
                    margin: 0,
                    fontSize: "0.75rem",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {JSON.stringify(debugState, null, 2)}
                </pre>
              </div>
            )}
            {!debugState && (
              <div style={{ marginTop: "0.5rem" }}>
                No internal state yet — send a line to see how the customer’s
                context and decisions evolve.
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
