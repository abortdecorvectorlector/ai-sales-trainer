// server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

import generateCustomerProfile from "./sim/generateCustomerProfile.js";
import {
  initializeSimState,
  getSimState,
  updateSimState, // NOTE: this now exists in your updated simState.js
  pushConversationTurn,
  resetSimState,
} from "./sim/simState.js";

import { SimStates, CustomerIntent, updateSimState as runStateMachine } from "./sim/stateMachine.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------------
// Middleware
// -------------------------
app.use(
  cors({
    origin: "*", // tighten later if needed
  })
);
app.use(express.json());

// -------------------------
// OpenAI client
// -------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------------------------
// Helpers
// -------------------------
const clamp01 = (n) => {
  const x = Number(n);
  if (Number.isNaN(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
};

function getSessionId(req) {
  const sid = req.headers["x-sim-session-id"];
  return typeof sid === "string" && sid.trim() ? sid.trim() : "default";
}

// “Close” detection to break loops deterministically
function detectRepCloseType(repLine = "") {
  const t = repLine.toLowerCase();

  const isScale = /\b1\s*[-–]\s*10\b/.test(t) || /\bout of 10\b/.test(t) || /\brate\b/.test(t);
  const isBinary =
    /\bor\b/.test(t) &&
    (/\bdo you want\b/.test(t) ||
      /\bwould you rather\b/.test(t) ||
      /\beither\b/.test(t) ||
      /\bwhich\b/.test(t) ||
      /\bsee the numbers\b/.test(t));

  const isNextStep =
    /\bmeter\b/.test(t) ||
    /\bbill\b/.test(t) ||
    /\bappointment\b/.test(t) ||
    /\bschedule\b/.test(t) ||
    /\bwhat time\b/.test(t) ||
    /\btomorrow\b/.test(t) ||
    /\btoday\b/.test(t);

  const isPermission =
    /\bcan i\b/.test(t) ||
    /\bcan we\b/.test(t) ||
    /\bmind if\b/.test(t) ||
    /\breal quick\b/.test(t) ||
    /\b30 seconds\b/.test(t) ||
    /\b15 seconds\b/.test(t);

  if (isScale) return "scale";
  if (isBinary) return "binary";
  if (isNextStep) return "next_step";
  if (isPermission) return "permission";
  return "none";
}

function shouldForceExit(simStage, flags, repPitch) {
  const closeType = detectRepCloseType(repPitch);
  const saturated = (flags?.objectionTurns ?? 0) >= 2; // 3rd objection-turn triggers forced exit
  return simStage === SimStates.OBJECTION_LOOP && closeType !== "none" && saturated;
}

function forceExitIntentByDifficulty(difficulty = "normal") {
  if (difficulty === "easy") return CustomerIntent.SOFT_YES_METER;
  if (difficulty === "normal") return Math.random() < 0.8 ? CustomerIntent.SOFT_YES_METER : CustomerIntent.CLARIFYING_QUESTION;
  if (difficulty === "tough") return Math.random() < 0.6 ? CustomerIntent.SOFT_YES_METER : CustomerIntent.CLARIFYING_QUESTION;
  return Math.random() < 0.25 ? CustomerIntent.SOFT_YES_METER : CustomerIntent.CLARIFYING_QUESTION;
}

function buildSystemPrompt(customerProfile, state, flags) {
  const allowedIntents = Object.values(CustomerIntent).join(" | ");

  return `
You are simulating a REAL HOMEOWNER for a professional sales training environment.

CRITICAL:
- You are the HOMEOWNER. Do NOT explain AI logic.
- Be human, realistic, and concise.
- You MUST output ONLY valid JSON in the exact schema below.

CURRENT CUSTOMER PROFILE (summary):
- incomeBand: ${customerProfile?.demographics?.incomeBand || "unknown"}
- moneyStressLevel: ${customerProfile?.demographics?.moneyStressLevel ?? "unknown"}
- riskAversion: ${customerProfile?.personality?.riskAversion ?? "unknown"}
- trustLevel: ${customerProfile?.personality?.trustLevel ?? "unknown"}
- toneProfile: ${customerProfile?.personality?.toneProfile || "mixed"}

CURRENT SIM (server-side):
- simStage: ${state?.simStage}
- turnCount: ${state?.turnCount}
- trust: ${state?.trust}
- objectionResistance: ${state?.objectionResistance}
- clarityLevel: ${state?.clarityLevel}
- urgencyToDecide: ${state?.urgencyToDecide}
- confusionLevel: ${state?.confusionLevel}

FLAGS:
- objectionTurns: ${flags?.objectionTurns ?? 0}
- askedForMeterCheck: ${flags?.askedForMeterCheck ?? false}
- meterPermissionSoftYes: ${flags?.meterPermissionSoftYes ?? false}
- appointmentSoftYes: ${flags?.appointmentSoftYes ?? false}
- appointmentTimeProposed: ${flags?.appointmentTimeProposed ?? false}
- appointmentConfirmed: ${flags?.appointmentConfirmed ?? false}

ANTI-LOOP RULE (MANDATORY):
- If the same concern has already been discussed multiple turns and the rep presents a clear close (binary choice, scale question, or next-step ask),
  you must STOP repeating the same objection.
- In that moment you MUST pick ONE realistic outcome: reluctant small yes, clear refusal, or deferral.

INTENT LABEL (MANDATORY):
You must set "customer_intent" to exactly ONE of:
${allowedIntents}

OUTPUT JSON (no extra keys):
{
  "customer_reply": "string",
  "customer_intent": "${allowedIntents}",
  "internal_reasoning": {
    "updated_state": {
      "trust": number,
      "objectionResistance": number,
      "clarityLevel": number,
      "urgencyToDecide": number,
      "confusionLevel": number,
      "lastObjection": string | null
    }
  }
}
`.trim();
}

// -------------------------
// Health
// -------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// -------------------------
// Reset sim (PER SESSION)
// -------------------------
app.post("/api/reset-sim", (req, res) => {
  const sessionId = getSessionId(req);
  resetSimState(sessionId);
  return res.json({ ok: true });
});

// -------------------------
// Simulate (PER SESSION)
// -------------------------
app.post("/api/simulate", async (req, res) => {
  const sessionId = getSessionId(req);

  try {
    const { product, customerType, objection, difficulty, pitch, history } = req.body;

    if (!pitch || !pitch.trim()) {
      return res.status(400).json({ error: "Pitch is required." });
    }

    // Get per-session sim
    let sim = getSimState(sessionId);

    // Initialize if needed
    if (!sim.customerProfile || !sim.state || !sim.flags) {
      const profile = generateCustomerProfile();

      // Init per-session store
      initializeSimState(sessionId, profile, {
        product: product || null,
        customerType: customerType || "mixed",
        difficulty: difficulty || "normal",
        forcedObjection: objection || null,
      });

      // Re-fetch after init
      sim = getSimState(sessionId);

      // Ensure SimStates stage exists
      updateSimState(sessionId, {
        state: {
          simStage: SimStates.INTRO,
        },
      });

      // Ensure flags exist (if stateMachine relies on them)
      updateSimState(sessionId, {
        flags: {
          objectionTurns: 0,
          askedForMeterCheck: false,
          meterPermissionSoftYes: false,
          appointmentSoftYes: false,
          appointmentTimeProposed: false,
          appointmentConfirmed: false,
        },
      });

      sim = getSimState(sessionId);
    }

    // Prefer server history, but accept client history for display/coach
    const serverTranscript = (sim.conversationHistory || [])
      .map((t) => `${t.role === "rep" ? "Rep" : "Customer"}: ${t.message}`)
      .join("\n");

    const clientTranscript = Array.isArray(history)
      ? history.map((m) => `${m.role === "rep" ? "Rep" : "Customer"}: ${m.text}`).join("\n")
      : "";

    const transcript = serverTranscript.trim().length > 0 ? serverTranscript : clientTranscript;

    // Log rep line
    pushConversationTurn(sessionId, { role: "rep", message: pitch });

    // Re-read sim after push
    sim = getSimState(sessionId);
    const state = sim.state || {};
    const flags = sim.flags || {};

    const system = buildSystemPrompt(sim.customerProfile, state, flags);

    const user = `
Conversation so far:
${transcript || "(none yet)"}

Rep's latest line:
Rep: ${pitch}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
    });

    const raw = completion.choices[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse model JSON:", raw);
      return res.status(500).json({ error: "Failed to parse AI response." });
    }

    let customer_reply = parsed.customer_reply || "";
    let customer_intent = parsed.customer_intent || CustomerIntent.NEW_OBJECTION;

    // Enforce allowed intents
    const allowed = new Set(Object.values(CustomerIntent));
    if (!allowed.has(customer_intent)) {
      customer_intent = CustomerIntent.NEW_OBJECTION;
    }

    // Stall-breaker: forced exit if objection loop saturated + rep closes
    sim = getSimState(sessionId);
    if (shouldForceExit(sim.state?.simStage, sim.flags, pitch)) {
      const forced = forceExitIntentByDifficulty(sim.state?.trainingConfig?.difficulty || difficulty || "normal");
      customer_intent = forced;

      if (forced === CustomerIntent.SOFT_YES_METER) {
        customer_reply =
          "Alright… if it’s truly just a quick look and I’m not signing anything, we can check it real quick.";
      } else if (forced === CustomerIntent.CLARIFYING_QUESTION) {
        customer_reply =
          "Okay—before we go further, what exactly are you needing from me, and is there any cost or contract today?";
      }
    }

    // Update continuous internal state from model
    const updated = parsed?.internal_reasoning?.updated_state;
    if (updated) {
      updateSimState(sessionId, {
        state: {
          trust: clamp01(updated.trust),
          objectionResistance: clamp01(updated.objectionResistance),
          clarityLevel: clamp01(updated.clarityLevel),
          urgencyToDecide: clamp01(updated.urgencyToDecide),
          confusionLevel: clamp01(updated.confusionLevel),
          lastObjection: updated.lastObjection ?? sim.state?.lastObjection ?? null,
        },
      });
    }

    // Run SimStates transition
    sim = getSimState(sessionId);

    const currentStage = sim.state?.simStage || SimStates.INTRO;
    const currentFlags = sim.flags || {};

    const nextStage = runStateMachine(currentStage, currentFlags, customer_intent);

    // Persist stage + flags (some machines mutate flags)
    updateSimState(sessionId, {
      state: { simStage: nextStage },
      flags: currentFlags,
    });

    // Log customer reply
    pushConversationTurn(sessionId, { role: "customer", message: customer_reply });

    // Final read
    const simFinal = getSimState(sessionId);

    return res.json({
      reply: customer_reply,
      customer_intent,
      simStage: simFinal.state?.simStage,
      flags: simFinal.flags,
      internal: {
        trust: simFinal.state?.trust,
        objectionResistance: simFinal.state?.objectionResistance,
        clarityLevel: simFinal.state?.clarityLevel,
        urgencyToDecide: simFinal.state?.urgencyToDecide,
        confusionLevel: simFinal.state?.confusionLevel,
      },
      // Optional: useful for debugging multi-device isolation
      session: sessionId,
    });
  } catch (err) {
    console.error("Error in /api/simulate:", err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

// -------------------------
// Hint / Coach (PER SESSION)
// -------------------------
app.post("/api/hint", async (req, res) => {
  const sessionId = getSessionId(req);

  try {
    const sim = getSimState(sessionId);

    const simStage = sim?.state?.simStage || "UNKNOWN";
    const flags = sim?.flags || {};

    const transcript =
      req.body?.transcript ||
      (sim?.conversationHistory || [])
        .map((t) => `${t.role === "rep" ? "Rep" : "Customer"}: ${t.message}`)
        .join("\n");

    const prompt = `
You are a sales coach for a door-to-door rep.

Current simStage: ${simStage}
Flags: ${JSON.stringify(flags, null, 2)}

Transcript so far (most recent at the bottom):
${transcript || "(none)"}

Give the rep:
1) A short coaching focus for this stage (1–2 sentences).
2) A suggested structure for the next sentence or two (not a full script).
Keep it under 120 words total.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        { role: "system", content: "You are a direct, practical sales coach." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const hintText = completion.choices[0]?.message?.content || "";
    return res.json({ hint: hintText });
  } catch (err) {
    console.error("Error in /api/hint:", err);
    return res.status(500).json({ error: "Failed to generate hint" });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
