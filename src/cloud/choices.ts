/**
 * Choice asks: the rules live in src/protocol/choice-asks.ts so the command edge and the hosted
 * MCP read the same ones. This module keeps the CLI's and local MCP's import path.
 */
export {
  CHOICE_DESCRIPTION_MAX,
  CHOICE_LABEL_MAX,
  CHOICE_MAX,
  CHOICE_MIN,
  CHOICE_OTHER_TEXT_MAX,
  choiceAnswerBody,
  choiceOptions,
  markRecommended,
  parseChoiceOptionFlag,
  type ChoiceOption,
  type ChoiceOptionInput,
} from "../protocol/choice-asks.js";
