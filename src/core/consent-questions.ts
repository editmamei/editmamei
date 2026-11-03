/**
 * The consent questions, one entry per setting a prompt can ask about. Raising a question's
 * `version` asks everyone with an older answer again, so a change to what a setting covers
 * reaches existing installs. Kept free of imports so settings.ts can read it.
 */

export type ConsentQuestionId = 'features';

export interface ConsentQuestion {
  id: ConsentQuestionId;
  version: number;
  /** Shown as-is. Under 150 characters, no links: some clients cut long prompts short. */
  message: string;
}

export const FEATURES_QUESTION: ConsentQuestion = {
  id: 'features',
  version: 1,
  message:
    'Share the names of editing features Editmamei uses? No files, text or scripts are sent. ' +
    'You can change this in settings.',
};

export const CONSENT_QUESTIONS: readonly ConsentQuestion[] = [FEATURES_QUESTION];
