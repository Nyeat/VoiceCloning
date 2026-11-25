// Which action leads the "Your audio" panel. Submitting locks the set, so while
// Part 2 is still to do the panel points to it first and keeps Submit as a quiet
// skip link. Any audio counts, recorded or uploaded: an uploaded lecture is the
// common "Part 1" for lecturers who never use the reader.

/**
 * @param {{ part: 1 | 2, hasAudio: boolean, partTwoDone: boolean, partTwoSkipped: boolean }} state
 * @returns {boolean} true when "Continue to Part 2" should be the primary button.
 */
export function shouldNudgePartTwo({ part, hasAudio, partTwoDone, partTwoSkipped }) {
  return part === 1 && hasAudio && !partTwoDone && !partTwoSkipped;
}
