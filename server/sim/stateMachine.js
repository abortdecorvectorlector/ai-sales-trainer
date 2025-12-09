export const SimStates = {
  INTRO: "INTRO",
  EXPLAIN_PROGRAM: "EXPLAIN_PROGRAM",
  OBJECTION_LOOP: "OBJECTION_LOOP",
  METER_SOFT_CLOSE: "METER_SOFT_CLOSE",
  AT_METER: "AT_METER",
  QUALIFICATION_RESULT: "QUALIFICATION_RESULT",
  APPT_SOFT_CLOSE: "APPT_SOFT_CLOSE",
  APPT_SCHEDULING: "APPT_SCHEDULING",
  APPT_CONFIRMED: "APPT_CONFIRMED",
};

// Very rough intent types for the CUSTOMER message
// (you can classify this using GPT in your existing backend prompt)
export const CustomerIntent = {
  NEW_OBJECTION: "NEW_OBJECTION",
  CLARIFYING_QUESTION: "CLARIFYING_QUESTION",
  SOFT_YES_METER: "SOFT_YES_METER",
  SOFT_YES_APPT: "SOFT_YES_APPT",
  TIME_NEGOTIATION: "TIME_NEGOTIATION",
  TIME_CONFIRMED: "TIME_CONFIRMED",
};

export function updateSimState(currentState, flags, customerIntent) {
  switch (currentState) {
    case SimStates.INTRO:
      // After you’ve delivered your opener & basic program explanation
      return SimStates.EXPLAIN_PROGRAM;

    case SimStates.EXPLAIN_PROGRAM:
      // As soon as they push back (“I don’t want to pay more / be locked in”)
      if (customerIntent === CustomerIntent.NEW_OBJECTION) {
        return SimStates.OBJECTION_LOOP;
      }
      return currentState;

    case SimStates.OBJECTION_LOOP:
      // If they give a soft yes to the meter (“we can take a quick look”)
      if (customerIntent === CustomerIntent.SOFT_YES_METER) {
        flags.meterPermissionSoftYes = true;
        flags.askedForMeterCheck = true;
        return SimStates.METER_SOFT_CLOSE;
      }
      // Otherwise, keep handling objections
      flags.objectionTurns += 1;
      return SimStates.OBJECTION_LOOP;

    case SimStates.METER_SOFT_CLOSE:
      // Rep is leading them around the side; once narration starts, we’re at meter
      return SimStates.AT_METER;

    case SimStates.AT_METER:
      // After explaining meter + battery + outages, next step is qualify
      flags.atMeter = true;
      // In your convo, you do: “good news — you qualify…”
      return SimStates.QUALIFICATION_RESULT;

    case SimStates.QUALIFICATION_RESULT:
      if (customerIntent === CustomerIntent.SOFT_YES_APPT) {
        flags.appointmentSoftYes = true;
        return SimStates.APPT_SOFT_CLOSE;
      }
      return currentState;

    case SimStates.APPT_SOFT_CLOSE:
      // This is where you ask: “later today or tomorrow afternoon?”
      return SimStates.APPT_SCHEDULING;

    case SimStates.APPT_SCHEDULING:
      if (customerIntent === CustomerIntent.TIME_CONFIRMED) {
        flags.appointmentConfirmed = true;
        return SimStates.APPT_CONFIRMED;
      }
      if (customerIntent === CustomerIntent.TIME_NEGOTIATION) {
        flags.appointmentTimeProposed = true;
        return SimStates.APPT_SCHEDULING;
      }
      return currentState;

    case SimStates.APPT_CONFIRMED:
      // Simulation is effectively “won”
      return SimStates.APPT_CONFIRMED;

    default:
      return currentState;
  }
}
