// One reference-clip selector for the whole system. The canonical module lives
// in lambda/shared so the server's automatic pick (lecture warm-up, boot warm,
// refresh_auto_references) and this page's pick choose the same clips for the
// same voice. Before 2026-11-17 the two copies had drifted (the server ignored
// clip length, sentence endings and speaker consistency).
export * from '../../../lambda/shared/referenceSelection.js';
