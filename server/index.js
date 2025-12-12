import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

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

function difficultyDescriptor(difficulty) {
  switch (difficulty) {
    case "easy":
      return "low resistance and fairly open to being convinced if the rep builds rapport and explains clearly. If the rep gives a few strong, clear answers about your main concern, you often move toward a soft yes or a quick appointment (for example, going to check the meter or grabbing a bill).";
    case "tough":
      return "high resistance, naturally skeptical, and needs strong proof and trust before softening. You may soften a bit or agree to a small next step if the rep handles your main concern very well.";
    case "nightmare":
      return "very high resistance, time-pressed, assumes door-to-door reps are a hassle or a scam. You are hard to win; if the rep is very strong you might move from a hard no to a guarded maybe or very tentative next step, otherwise you shut it down.";
    case "normal":
    default:
      return "moderate resistance, like a typical homeowner with doubts but also some curiosity. If the rep answers your key concerns clearly (cost, commitment, hassle), you can gradually become more open and sometimes agree to hear more or set an appointment.";
  }
}

function customerTypeDescriptor(customerType) {
  switch (customerType) {
    case "skeptical":
      return "skeptical and probing, asks hard questions and looks for reasons to say no, but still listens.";
    case "busy":
      return "busy and rushed, in the middle of something, impatient with long explanations, focused on time and getting back to what they were doing.";
    case "friendly":
      return "casually polite but still cautious. Will give the rep a fair shot if they are clear and quick, but still guards their time.";
    case "hostile":
      return "annoyed at being interrupted, defensive and quick to push back. You speak bluntly and keep your answers short. You very rarely thank the rep.";
    case "mixed":
    default:
      return "unpredictable: some turns are neutral, some rushed, some skeptical. You generally sound a bit interrupted or wary rather than warm.";
  }
}

function buildSimPrompt({ product, customerType, objection, difficulty, pitch, history }) {
  const historyText = (history || [])
    .map((m) => {
      const speaker = m.role === "rep" ? "Rep" : "Customer";
      return `${speaker}: ${m.text}`;
    })
    .join("\n");

  const typeDesc = customerTypeDescriptor(customerType);
  const diffDesc = difficultyDescriptor(difficulty);

  const trainerObjection = objection && objection.trim().length > 0 ? objection.trim() : "";

  return `
You are roleplaying as a realistic homeowner answering the door to a door-to-door rep.

TRAINER-SELECTED MAIN OBJECTION THEME (IF ANY):
- Selected main objection theme: ${
    trainerObjection ? `"${trainerObjection}"` : "(none – you must choose a primary context randomly from the weighted list below)"
  }

TONE & REALISM:
- Customer style: ${typeDesc}
- Resistance level: ${diffDesc}

Conversation so far:
${historyText || "(No previous conversation yet.)"}

The rep's latest line is:
Rep: ${pitch}

(KEEP ALL YOUR EXISTING RULES BELOW THIS LINE — unchanged)
`;
}

// ---------- NEW: close detection (cheap + effective) ----------
function detectCloseType(repLine = "") {
  const t = repLine.toLowerCase();

  // binary choice: "either/or", "A or B", "do you want X or Y"
  const isBinary =
    /\bor\b/.test(t) &&
    (/\bdo you want\b/.test(t) ||
      /\bwould you rather\b/.test(t) ||
      /\bwhich\b/.test(t) ||
      /\beither\b/.test(t));

  // scale: "1-10", "out of 10", "rate it"
  const isScale = /\b1\s*[-–]\s*10\b/.test(t) || /\bout of 10\b/.test(t) || /\brate\b/.test(t);

  // permission advance: "can i show", "can we", "mind if", "real quick"
  const isPermission =
    /\bcan i\b/.test(t) ||
    /\bcan we\b/.test(t) ||
    /\bmind if\b/.test(t) ||
    /\breal quick\b/.test(t) ||
    /\b30 seconds\b/.test(t) ||
    /\b15 seconds\b/.test(t);

  // explicit next step ask: meter / bill / appointment language
  const isNextStep =
    /\bmeter\b/.test(t) ||
    /\bbill\b/.test(t) ||
    /\bappointment\b/.test(t) ||
    /\bschedule\b/.test(t) ||
    /\bwhat time\b/.test(t) ||
    /\btomorrow\b/.test(t) ||
    /\btoday\b/.test(t);

  if (isScale) return "scale";
  if (isBinary) return "binary";
  if (isNextStep) return "next_step";
  if (isPermission) return "permission";
  return "none";
}

// ---------- NEW: forced decision + reply generator ----------
function shouldForceExit({ mainMentions, latestDecision, closeType }) {
  const looping = latestDecision === "restated_objection" || latestDecision === "still_hesitant";
  const saturated = typeof mainMentions === "number" && mainMentions >= 3;
  const repClosing = closeType !== "none";
  return saturated && looping && repClosing;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function forceDecision(difficulty = "normal") {
  // Bias toward small_yes on easy/normal; more firm_no on tough/nightmare
  if (difficulty === "easy") return "small_yes";

  if (difficulty === "normal") {
    return Math.random() < 0.75 ? "small_yes" : "firm_no";
  }

  if (difficulty === "tough") {
    return Math.random() < 0.55 ? "small_yes" : "firm_no";
  }

  // nightmare
  return Math.random() < 0.25 ? "small_yes" : "firm_no";
}

function generateForcedCustomerReply({ forced, category }) {
  // Keep these short + natural. Tie to category where possible.
  if (forced === "firm_no") {
    return pick([
      "No, I’m going to pass. I don’t want to deal with anything new right now.",
      "I hear you, but no — not interested. Have a good one.",
      "I’m not doing this right now. Thanks though.",
    ]);
  }

  // small_yes
  switch (category) {
    case "money/budget":
      return pick([
        "Alright… if it’s truly just a quick look and no signup, we can check that meter real fast.",
        "Okay, we can look at the numbers for a minute, but I’m not committing to anything.",
        "Fine — show me quick. If it starts sounding expensive, I’m out.",
      ]);
    case "trust / scams / contracts":
      return pick([
        "Okay, I’ll hear you out for a minute — but I’m not signing anything today.",
        "Alright, quick look is fine. I’m still skeptical though.",
        "We can check the basics, but I’m not agreeing to a contract right now.",
      ]);
    case "time / busy / hassle":
      return pick([
        "Make it quick — what do you need to look at?",
        "Alright, one minute. Show me what you mean.",
        "Okay, fast version. What’s the next step?",
      ]);
    case "moving timeline":
      return pick([
        "Okay, quick look is fine, but we might be moving soon — keep it simple.",
        "Alright, we can check it quickly. Just be straight with me.",
      ]);
    case "roof condition":
      return pick([
        "Okay, quick look is fine — but I’m not doing anything that messes with the roof.",
        "Alright, show me, but my roof situation is a concern.",
      ]);
    case "spouse/decision-maker":
      return pick([
        "We can look quick, but my spouse makes the final call.",
        "Okay, show me briefly — but I’m not deciding without them.",
      ]);
    case "outages / reliability":
      return pick([
        "Alright, quick look is fine — I just care about outages and reliability.",
        "Okay, show me. If it helps with outages, I’ll listen.",
      ]);
    default:
      return pick([
        "Alright, quick look is fine — what do you need from me?",
        "Okay, show me quick. I’m still cautious though.",
      ]);
  }
}

app.post("/api/simulate", async (req, res) => {
  try {
    const { product, customerType, objection, difficulty, pitch, history } = req.body;

    if (!pitch || !pitch.trim()) {
      return res.status(400).json({ error: "Pitch is required." });
    }

    // Close detection (rep line)
    const closeType = detectCloseType(pitch);

    const prompt = buildSimPrompt({
      product,
      customerType,
      objection,
      difficulty,
      pitch,
      history,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an AI sales training coach and simulated homeowner. Always respond EXACTLY with valid JSON and nothing else.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.85,
    });

    const content = completion.choices[0]?.message?.content;

    let data;
    try {
      data = JSON.parse(content);
    } catch (err) {
      console.error("Error parsing JSON from model:", err);
      console.error("Raw content:", content);
      return res.status(500).json({ error: "Failed to parse AI response." });
    }

    let { customer_reply, scores, tips, state } = data;

    // ---------- NEW: server-enforced stall breaker ----------
    const mainMentions = state?.main_objection_mentions ?? 0;
    const latestDecision = state?.latest_decision ?? "still_hesitant";
    const category = state?.main_objection_category ?? "money/budget";

    if (shouldForceExit({ mainMentions, latestDecision, closeType })) {
      const forced = forceDecision(difficulty);

      // Force the sim to exit the loop in a human way.
      customer_reply = generateForcedCustomerReply({ forced, category });

      // Keep your state consistent with forced outcome
      state = {
        ...state,
        latest_decision: forced,
        micro_commitment_taken: forced === "small_yes" ? true : state?.micro_commitment_taken ?? false,
        appointment_committed: forced === "firm_yes" ? true : state?.appointment_committed ?? false,
      };

      // Nudge scoring to reflect “your line succeeded at breaking the loop”
      scores = {
        ...(scores || {}),
        objection_handling: Math.max(scores?.objection_handling ?? 7, 7),
        overall: Math.max(scores?.overall ?? 7, 7),
      };

      // Tips now shift to “advance the process” instead of re-answering
      tips = [
        "Confirm the small yes, then give the next micro-step.",
        "Ask one tight qualifier question, then move forward.",
        "Offer two appointment windows and stay silent.",
      ];
    }

    return res.json({
      reply: customer_reply,
      score: scores,
      tips,
      state,
    });
  } catch (error) {
    console.error("Error in /api/simulate:", error);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

// Hint endpoint unchanged (your existing code)
app.post("/api/hint", async (req, res) => {
  const { simState, flags, transcript } = req.body;

  try {
    const prompt = `
You are a sales coach for a solar/battery door-to-door rep.

Current simulation state: ${simState}
Flags: ${JSON.stringify(flags, null, 2)}

Transcript so far (most recent at the bottom):
${transcript}

Give the rep:
1) A short coaching focus for this state (1–2 sentences).
2) A suggested structure for the next sentence or two they could say (not a full script, just a push in the right direction).
Keep it under 120 words total.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        { role: "system", content: "You are a direct, practical sales coach." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const hintText = completion.choices[0].message.content;
    res.json({ hint: hintText });
  } catch (err) {
    console.error("Error in /api/hint:", err);
    res.status(500).json({ error: "Failed to generate hint" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
