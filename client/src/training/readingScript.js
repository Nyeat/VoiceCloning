// A reading script for people without a lecture recording. Written to train
// well, not just to fill time:
// - Sentences of ~10-18 words (about 4-7 s spoken). The training slicer cuts at
//   pauses of 0.3 s+ into clips of at least 4 s (gpu-worker pipeline.js), and
//   the reference picker scores 3-9 s clips with clean transcripts highest
//   (lambda/shared/referenceSelection.js), so a short pause after each
//   sentence yields exactly the clips it prefers.
// - Every common English sound, numbers, names, questions, lists and emphasis,
//   so the voice learns more than one flat reading tone.
// - Lecture-style medical passages, the voice's real use.
// About 1,350 words in ~107 sentences: roughly 10-12 minutes with the pauses.

export const READING_SCRIPT_TIPS = [
  'Read at your normal lecturing pace, as if explaining to a class.',
  'Pause briefly after every sentence, and a little longer between paragraphs.',
  'If you stumble, pause, then simply read the whole sentence again.',
  'About 10–12 minutes. Read it once, then add a lecture recording if you have one (aim for 10–30 minutes in total).',
];

export const READING_SCRIPT = [
  {
    title: 'Getting started',
    paragraphs: [
      'Good morning, everyone, and thank you for joining me today. I am recording this so that my voice can be used to explain ideas clearly. I will speak at my usual pace, the same way I would in a lecture theatre. Some sentences will be short. Others will be a little longer, with a pause in between.',
      'Before we begin, let me say a few words about how we will spend our time. We will start with some everyday sentences, then move on to a short lesson. After that, we will look at numbers, names and a few questions. Please take notes if it helps you, and do not worry about remembering everything at once.',
    ],
  },
  {
    title: 'Everyday sentences',
    paragraphs: [
      'The quick brown fox jumps over the lazy dog near the riverbank. She sells sea shells by the seashore every summer afternoon. A large yellow bus stopped at the corner of the busy street. The children watched the thunderstorm roll across the hills from the window.',
      'Fresh bread smells wonderful early in the morning, especially on a cold day. My grandfather kept a small garden full of tomatoes, beans and sweet peppers. We should have left the house earlier to avoid the heavy traffic. The judge listened carefully before giving her final decision to the court.',
      'Please measure the water precisely before you pour it into the jug. The old clock in the hallway chimed twelve times at midnight. Choose the shortest route, but watch out for the narrow bridge ahead. Thousands of birds gathered on the beach as the tide went out.',
      'He thought the treasure was hidden somewhere beneath the oak tree. Zebras, giraffes and elephants shared the watering hole without any trouble. A gentle breeze carried the scent of jasmine through the open door. Usually, the measure of a good plan is how well it handles surprises.',
    ],
  },
  {
    title: 'A short lesson: the heart',
    paragraphs: [
      'Today we are going to talk about the heart and the circulation of blood. The heart is a muscular pump about the size of a closed fist. It sits in the chest, slightly to the left, protected by the ribs and the sternum.',
      'The heart has four chambers: two atria above and two ventricles below. Blood returning from the body enters the right atrium through the large veins. It then passes into the right ventricle, which pumps it to the lungs. In the lungs, the blood releases carbon dioxide and picks up fresh oxygen.',
      'Oxygen-rich blood returns to the left atrium and flows into the left ventricle. The left ventricle has the thickest wall, because it must push blood around the entire body. Valves between the chambers open and close to keep blood moving in one direction. The sound of those valves closing is what we hear through a stethoscope.',
      'Now, why does this matter clinically? When a valve becomes narrow or leaky, the heart has to work much harder. Over time, that extra effort can weaken the muscle and lead to heart failure. Patients may notice breathlessness, swollen ankles, or tiredness after only mild activity.',
      'So, when you examine a patient, listen carefully and think about what each sound means. A murmur is simply turbulent flow, but its timing tells you a great deal. Is it heard during systole, or during diastole? Where is it loudest, and does it spread towards the neck or the armpit?',
    ],
  },
  {
    title: 'Numbers, dates and names',
    paragraphs: [
      'The normal resting heart rate for an adult is between sixty and one hundred beats per minute. A typical blood pressure reading might be one hundred and twenty over eighty. The human body contains roughly five litres of blood in total. Normal body temperature is about thirty-six point eight degrees Celsius.',
      'Our next lecture is on Tuesday, the fourteenth of March, at half past two in the afternoon. The examination will take place on the second of June, in Lecture Theatre Three. Please submit your assignment before eleven fifty-nine on Friday night. Late submissions lose ten percent of the marks for each day.',
      'In nineteen twenty-eight, Alexander Fleming noticed that mould had stopped bacteria from growing. William Harvey described the circulation of blood in sixteen twenty-eight. Florence Nightingale used statistics to show how hygiene could save lives. Today, Singapore, London and Boston all train doctors using these same foundations.',
      'Here is a quick list to remember: one, wash your hands; two, introduce yourself; three, confirm the patient’s identity. Four, explain what you are about to do; and five, ask for permission before you begin. These five steps take less than a minute, yet they build trust immediately.',
    ],
  },
  {
    title: 'Questions and emphasis',
    paragraphs: [
      'Have you ever wondered why some people recover quickly while others do not? What changes when a patient finally understands their own condition? Could a simple conversation improve someone’s health as much as a new medicine? These are questions worth asking, again and again, throughout your career.',
      'Let me be absolutely clear: this step is not optional. You must check the dose before every single injection, without exception. It is not enough to be fairly sure; you need to be certain. And if you are ever unsure, stop, and ask someone for help.',
      'Really? Yes, really. It sounds surprising, but it is true. Wait a moment, though — there is one important exception we need to discuss. Remarkably, the same rule applies to children, to adults, and to older patients alike.',
    ],
  },
  {
    title: 'A short lesson: infection and antibiotics',
    paragraphs: [
      'Let us move on to infection, and to the medicines we use to treat it. Bacteria are single-celled organisms that can live almost anywhere, including inside us. Most of them are harmless, and many are actually helpful to our digestion. Only a small number cause disease, but those can be very serious.',
      'Antibiotics work by attacking structures that bacteria need, but our own cells do not. Some antibiotics break down the bacterial cell wall, so the organism bursts. Others block the machinery that bacteria use to make proteins. Either way, the infection is controlled while the patient’s own tissues are spared.',
      'However, bacteria adapt remarkably quickly when antibiotics are used carelessly. Each unnecessary prescription gives resistant organisms a chance to survive and spread. That is why we should prescribe the right drug, at the right dose, for the right duration. It is also why viral infections, such as the common cold, should not be treated with antibiotics.',
      'Imagine a patient who arrives with a fever, a cough, and a fast breathing rate. What would you want to know first, and which tests would you order? You might check oxygen levels, listen to the chest, and request a chest X-ray. Thinking in this order keeps the patient safe while you gather the evidence.',
    ],
  },
  {
    title: 'Telling a story',
    paragraphs: [
      'Many years ago, a young doctor was working alone on a quiet night shift. Just after three in the morning, the phone rang with an urgent call from the ward. An elderly man had become confused, and his breathing had suddenly changed. She hurried down the corridor, her footsteps echoing in the empty building.',
      'When she reached his bedside, she spoke to him calmly and held his hand. She checked his pulse, looked at his chart, and noticed a small but crucial detail. A new medication had been started that afternoon, at a dose that was far too high. She stopped it at once, called her senior colleague, and stayed with the patient until he settled.',
      'By morning, the man was sitting up in bed, asking cheerfully for a cup of tea. Years later, she still told that story to every new group of students she taught. The lesson, she would say, is simple: notice the details, and never stop asking why.',
    ],
  },
  {
    title: 'Closing',
    paragraphs: [
      'That brings us to the end of today’s session. Thank you for your attention and your thoughtful questions. Please review your notes this evening, while the ideas are still fresh. If anything was unclear, send me a message, and I will be happy to explain it again.',
      'Remember that learning medicine is a long journey, not a single race. Be patient with yourselves, support one another, and keep your curiosity alive. I look forward to seeing all of you next week. Goodbye for now, and take care.',
    ],
  },
];

// Plain text for the Copy button: titles as headings, paragraphs separated.
export function readingScriptText(script = READING_SCRIPT) {
  return script
    .map((section) => [section.title.toUpperCase(), ...section.paragraphs].join('\n\n'))
    .join('\n\n\n');
}

export function readingScriptWordCount(script = READING_SCRIPT) {
  return script
    .flatMap((section) => section.paragraphs)
    .join(' ')
    .split(/\s+/u)
    .filter(Boolean).length;
}
