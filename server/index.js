// server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

import generateCustomerProfile from "./sim/generateCustomerProfile.js";
import {
  initializeSimState,
  getSimState,
  updateSimState as mergeSimState, // merges into simState.state
  pushConversationTurn,
  resetSimState,
} from "./sim/simState.js";

import { SimStates, CustomerIntent, updateSimState as runStateMachine } from "./sim/stateMachine.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: "*",
  })
);
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ============================================================
   Helpers
   ============================================================ */
const clamp01 = (n) => {
  const x = Number(n);
  if (Number.isNaN(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
};

// Cheap close detection (good enough to break loops deterministically)
function detectRepCloseType(repLine = "") {
  const t = repLine.toLowerCase();

  const isScale = /\b1\s*[-–]\s*10\b/.test(t) || /\bout of 10\b/.test(t) || /\brate\b/.test(t);
  const isBinary =
    /\bor\b/.test(t) &&
    (/\bdo you want\b/.test(t) || /\bwould you rather\b/.test(t) || /\beither\b/.test(t) || /\bwhich\b/.test(t));
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

// Enforced stall-breaker: if OBJECTION_LOOP + saturated + rep closes -> force exit intent
function shouldForceExit(simStage, flags, repPitch) {
  const closeType = detectRepCloseType(repPitch);
  const saturated = (flags?.objectionTurns ?? 0) >= 2; // 3rd time triggers forced exit
  return simStage === SimStates.OBJECTION_LOOP && closeType !== "none" && saturated;
}

function forceExitIntentByDifficulty(difficulty = "normal") {
  // Bias to SOFT_YES_METER. You can later add firm_no as another intent if you add it to CustomerIntent.
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
      "confusionLevel": number
    }
  }
}
`.trim();
}

/* ============================================================
   API: simulate
   ============================================================ */
app.post("/api/simulate", async (req, res) => {
  try {
    const { product, customerType, objection, difficulty, pitch, history } = req.body;

    if (!pitch || !pitch.trim()) {
      return res.status(400).json({ error: "Pitch is required." });
    }

    // Initialize sim if needed
    const sim = getSimState();
    if (!sim.customerProfile || !sim.state) {
      const profile = generateCustomerProfile();

      // keep your existing init, then we extend state with SimStates + flags
      initializeSimState(profile);

      const simInit = getSimState();
      const base = simInit.state || {};

      mergeSimState({
        state: {
          ...base,
          simStage: SimStates.INTRO,
          trainingConfig: {
            product: product || null,
            customerType: customerType || "mixed",
            difficulty: difficulty || "normal",
            forcedObjection: objection || null,
          },
          flags: {
            objectionTurns: 0,
            askedForMeterCheck: false,
            meterPermissionSoftYes: false,
            appointmentSoftYes: false,
            appointmentTimeProposed: false,
            appointmentConfirmed: false,
          },
        },
      });
    }

    // Refresh sim after possible init
    const sim2 = getSimState();
    const { customerProfile } = sim2;
    const state = sim2.state || {};
    const flags = state.flags || {};

    // Use either incoming history (front-end) or server-held conversationHistory.
    // Prefer server-held for correctness if present.
    const serverTranscript = (sim2.conversationHistory || [])
      .map((t) => `${t.role === "rep" ? "Rep" : "Customer"}: ${t.message}`)
      .join("\n");

    const clientTranscript = Array.isArray(history)
      ? history
          .map((m) => `${m.role === "rep" ? "Rep" : "Customer"}: ${m.text}`)
          .join("\n")
      : "";

    const transcript = serverTranscript.trim().length > 0 ? serverTranscript : clientTranscript;

    // Log rep line to server-side history
    pushConversationTurn({ role: "rep", message: pitch });

    const system = buildSystemPrompt(customerProfile, state, flags);

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

    // Stall breaker (server-enforced)
    if (shouldForceExit(state.simStage, flags, pitch)) {
      const forced = forceExitIntentByDifficulty(state.trainingConfig?.difficulty || "normal");
      customer_intent = forced;

      if (forced === CustomerIntent.SOFT_YES_METER) {
        customer_reply =
          "Alright… if it’s truly just a quick look and I’m not signing anything, we can check it real quick.";
      } else if (forced === CustomerIntent.CLARIFYING_QUESTION) {
        customer_reply =
          "Okay—before we go further, what exactly are you needing from me, and is there any cost or contract today?";
      }
    }

    // Update continuous state (server-side)
    const updated = parsed?.internal_reasoning?.updated_state;
    if (updated) {
      mergeSimState({
        state: {
          trust: clamp01(updated.trust),
          objectionResistance: clamp01(updated.objectionResistance),
          clarityLevel: clamp01(updated.clarityLevel),
          urgencyToDecide: clamp01(updated.urgencyToDecide),
          confusionLevel: clamp01(updated.confusionLevel),
        },
      });
    }

    // Run SimStates transition (source of truth)
    const sim3 = getSimState();
    const currentStage = sim3.state.simStage || SimStates.INTRO;
    const currentFlags = sim3.state.flags || flags;

    const nextStage = runStateMachine(currentStage, currentFlags, customer_intent);

    // Persist stage + flags (flags is mutated by stateMachine)
    mergeSimState({
      state: {
        simStage: nextStage,
        flags: currentFlags,
      },
    });

    // Log customer reply
    pushConversationTurn({ role: "customer", message: customer_reply });

    const sim4 = getSimState();
    return res.json({
      reply: customer_reply,
      customer_intent,
      simStage: sim4.state.simStage,
      flags: sim4.state.flags,
      internal: {
        trust: sim4.state.trust,
        objectionResistance: sim4.state.objectionResistance,
        clarityLevel: sim4.state.clarityLevel,
        urgencyToDecide: sim4.state.urgencyToDecide,
        confusionLevel: sim4.state.confusionLevel,
      },
    });
  } catch (err) {
    console.error("Error in /api/simulate:", err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

/* ============================================================
   API: hint (kept, but made compatible with new state/flags)
   ============================================================ */
app.post("/api/hint", async (req, res) => {
  try {
    const sim = getSimState();
    const simStage = sim?.state?.simStage || "UNKNOWN";
    const flags = sim?.state?.flags || {};
    const transcript = (sim?.conversationHistory || [])
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

/* ============================================================
   API: reset sim
   ============================================================ */
app.post("/api/reset-sim", (req, res) => {
  resetSimState();
  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
