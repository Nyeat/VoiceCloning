// The person training a voice sees three plain stages and one progress bar,
// not the nine pipeline steps (useSSE STEP_NAMES order). Weights are each
// step's rough share of a run: the two model trainings take most of the time.
const STEP_WEIGHTS = [3, 4, 6, 2, 4, 2, 4, 40, 35];

export const TRAINING_STAGES = [
  { label: 'Preparing your recordings', steps: [0, 1, 2] },
  { label: 'Analysing your voice', steps: [3, 4, 5, 6] },
  { label: 'Learning your voice', steps: [7, 8] },
];

const isFinished = (status) => status === 'done' || status === 'skipped';

export function summarizeTrainingProgress(steps = [], pipelineStatus = 'idle') {
  const statusAt = (index) => steps.find((step) => step.index === index)?.status || 'pending';
  const total = STEP_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  let earned = 0;
  STEP_WEIGHTS.forEach((weight, index) => {
    const status = statusAt(index);
    if (isFinished(status)) earned += weight;
    else if (status === 'running') earned += weight / 2;
  });
  const complete = pipelineStatus === 'complete';
  const failed = pipelineStatus === 'error' || steps.some((step) => step.status === 'error');
  // Never show 100% until the run really finished.
  const percent = complete ? 100 : Math.min(99, Math.round((earned / total) * 100));

  const stages = TRAINING_STAGES.map((stage) => {
    const statuses = stage.steps.map(statusAt);
    const state = complete || statuses.every(isFinished)
      ? 'done'
      : statuses.includes('error')
        ? 'error'
        : statuses.some((status) => status === 'running' || isFinished(status))
          ? 'active'
          : 'pending';
    return { label: stage.label, state };
  });
  const currentIndex = complete
    ? stages.length - 1
    : Math.max(0, stages.findIndex((stage) => stage.state !== 'done'));

  return {
    percent,
    complete,
    failed,
    currentIndex,
    currentLabel: complete ? 'Your voice is ready' : stages[currentIndex].label,
    stages,
  };
}
