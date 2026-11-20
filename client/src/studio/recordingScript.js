// The ~30 minute recording script for the Voice Studio recording portal.
//
// Part A reuses the training site's neutral script (~11 min, every English
// sound, numbers, names). Part B adds ~19 minutes that each ask for a different
// delivery — warm, enthusiastic, serious, empathetic, curious, emphatic,
// storytelling, calm, light — because a voice trained on one flat reading tone
// can only ever sound flat. Sentences stay ~8-18 words so the training slicer
// gets 3-9 second clips at the pauses.
import { READING_SCRIPT } from '../training/readingScript.js';

export const SCRIPT_TIPS = [
  'You do not have to read this — your own lecture recordings work too. The script just makes it easy.',
  'Record in a quiet room, about a hand-span from the microphone, and keep that distance.',
  'Pause briefly after every sentence. If you stumble, pause and read the whole sentence again.',
  'Follow the mood cue for each section — that is what lets your voice sound natural in every situation.',
  'Record one section at a time; each becomes its own file. Take a break whenever you like.',
];

const NEUTRAL_CUE = { mood: 'Neutral', cue: 'Your normal, clear lecturing voice.' };

const PART_B = [
  {
    title: 'Warm welcome',
    mood: 'Warm',
    cue: 'Smile while you speak. Friendly, unhurried, as if greeting a new class.',
    paragraphs: [
      'Hello, and a very warm welcome to all of you. It is genuinely lovely to see so many new faces this year. I remember sitting where you are now, a little nervous and very excited. Please know that every question you have is a good question here.',
      'Over the coming weeks we will learn a great deal together. Some days will feel easy, and some days will feel hard. That is completely normal, and it is how real learning feels. My door is always open, so come and find me whenever you need to.',
      'Take a moment to look around at the people beside you. They will be your colleagues, your study partners and, I hope, your friends. Medicine is a team effort from the very first day. Look after each other, and you will go far.',
    ],
  },
  {
    title: 'Enthusiasm and discovery',
    mood: 'Excited',
    cue: 'Energetic and bright. Let your voice rise — you are sharing something amazing.',
    paragraphs: [
      'This is honestly one of my favourite topics in the whole course! Just think about it: every cell in your body carries the same instructions. Yet a neuron and a muscle cell look and behave completely differently. How on earth does that happen? That is the wonderful puzzle we are solving today.',
      'When the first images of a living cell dividing were captured, people were astonished. Suddenly we could watch chromosomes line up and separate in real time. It changed how we teach, how we research and how we treat disease. And the best part is that the discoveries are still coming, every single year.',
      'Here is the brilliant thing about antibodies. Each one is shaped to recognise one particular target, almost like a key in a lock. Your immune system can produce millions of different keys. That is why vaccines work so beautifully, and it is truly remarkable.',
    ],
  },
  {
    title: 'Serious and clinical',
    mood: 'Serious',
    cue: 'Steady, lower, deliberate. Clear warning tone — this matters for patient safety.',
    paragraphs: [
      'Now I need your full attention, because this part is about patient safety. A missed allergy can turn a routine prescription into a medical emergency. Always check the allergy record before you give any medication. Always. There are no exceptions to this rule.',
      'Sepsis is a life-threatening condition, and time is critical. Every hour of delay in treatment increases the risk of death. Watch for fever, a rapid heart rate, fast breathing and confusion. If you suspect sepsis, escalate immediately and do not wait to be certain.',
      'Hand hygiene is the single most effective way to prevent hospital infections. It sounds simple, and that is exactly why people skip it. Wash your hands before and after every patient contact. Your patients are trusting you with their lives.',
    ],
  },
  {
    title: 'Empathy with a patient',
    mood: 'Gentle',
    cue: 'Soft and kind, slower. You are speaking to a worried patient, not a class.',
    paragraphs: [
      'I can see this news is a lot to take in, and that is completely understandable. Please take all the time you need. There is no rush at all. When you are ready, I will explain what happens next, one step at a time.',
      'You are not alone in this. Our team will be with you through every stage of your treatment. If anything worries you, even something small, please tell us. We would much rather hear it than have you carry it on your own.',
      'Is there someone you would like us to call for you? Sometimes it helps to have a family member here. You can ask me the same question as many times as you need. I am here to help you understand, and to make this a little easier.',
    ],
  },
  {
    title: 'Questions and curiosity',
    mood: 'Curious',
    cue: 'Real questions — let your voice go up at the end. Pause as if waiting for an answer.',
    paragraphs: [
      'So what do you think happens when blood pressure suddenly drops? Does the heart beat faster, or slower? Why would the body choose that response? Take a few seconds and think about it before I tell you.',
      'Have you ever wondered why we shiver when we are cold? Or why a fever makes us feel so tired? Could these be useful, rather than just unpleasant? What would happen if the body could not do them at all?',
      'Who here has seen a patient with jaundice? What colour were the whites of their eyes? Where does that yellow colour actually come from? And which organ do you think we should examine first?',
      'Is it the liver, the gallbladder, or something in the blood itself? How would you tell the difference at the bedside? Which test would you order first, and why? Good. Now let us check your reasoning together.',
    ],
  },
  {
    title: 'Emphasis and contrast',
    mood: 'Emphatic',
    cue: 'Stress the word that matters in each sentence. Clear contrast between the pairs.',
    paragraphs: [
      'Arteries carry blood away from the heart; veins carry blood back to it. It is not the size of the vessel that matters, but its direction. Type one diabetes is autoimmune; type two is mostly about insulin resistance. They share a name, but they are very different diseases.',
      'This is not a minor detail. It is the main point of the entire lecture. You do not need to memorise every enzyme. You do need to understand the overall pathway. Remember the principle first, and the facts will follow.',
      'Sensitivity tells you how good a test is at catching disease. Specificity tells you how good it is at ruling disease out. A highly sensitive test, when negative, helps you rule out. A highly specific test, when positive, helps you rule in.',
    ],
  },
  {
    title: 'Numbers, doses and dates',
    mood: 'Precise',
    cue: 'Careful and exact. Read every number fully and clearly.',
    paragraphs: [
      'A normal resting heart rate is between 60 and 100 beats per minute. Normal body temperature is about 37 degrees Celsius. A blood pressure of 120 over 80 is considered healthy for most adults. Oxygen saturation should usually be above 95 percent.',
      'The adult dose is 500 milligrams, taken twice a day for seven days. For children, it is 25 milligrams per kilogram, divided into two doses. Do not exceed 4 grams of paracetamol in 24 hours. Recheck the potassium level after 48 hours.',
      'The clinic opens at 8:30 in the morning and closes at 5:45 in the evening. Your next appointment is on Tuesday, the 14th of March, at 2:15 pm. The ward phone number is 6 5 9 2, 3 3 0 7. Please arrive about 15 minutes early.',
      'In 1928, Alexander Fleming noticed mould killing bacteria on a culture plate. By the 1940s, penicillin was saving thousands of lives. Today, around 1 in 3 prescriptions in some hospitals is an antibiotic. Roughly 70 percent of those are appropriate.',
    ],
  },
  {
    title: 'Medical terms',
    mood: 'Neutral',
    cue: 'Your clear teaching voice. Say each term carefully, as you would to a class.',
    paragraphs: [
      'Myocardial infarction occurs when blood flow to part of the heart muscle is blocked. Atherosclerosis narrows the coronary arteries over many years. Troponin is the key biomarker we measure in the blood. Electrocardiography shows the pattern of electrical activity.',
      'The hypothalamus and the pituitary gland control much of the endocrine system. Glucocorticoids, such as cortisol, affect metabolism and inflammation. Thyroxine regulates the body\'s metabolic rate. Hyperthyroidism and hypothyroidism produce opposite symptoms.',
      'Haemoglobin carries oxygen in erythrocytes, the red blood cells. Thrombocytopenia means a low platelet count. Leukocytosis means a raised white cell count, often from infection. Anaemia, thrombosis and coagulation are terms you will hear every day on the wards.',
      'Pharmacokinetics describes what the body does to a drug. Pharmacodynamics describes what the drug does to the body. Bioavailability, half-life and clearance all shape the dose we choose. Nephrotoxicity and hepatotoxicity are side effects we monitor closely.',
    ],
  },
  {
    title: 'Telling a story',
    mood: 'Storytelling',
    cue: 'Relaxed and expressive, like telling a story to friends. Vary your pace.',
    paragraphs: [
      'Let me tell you about a patient I met during my first year as a junior doctor. It was a quiet Sunday night, and the ward was almost silent. An elderly man pressed his call bell and said he simply felt wrong. His observations looked normal, and he could not explain what was bothering him.',
      'Something about the way he said it stayed with me. So I sat down, listened, and examined him again, more slowly this time. His abdomen was a little more tender than before. I called my senior, and within the hour he was in theatre.',
      'He recovered well, and months later he came back to thank the team. I have never forgotten that night. The lesson was not about a clever test or a rare disease. It was about listening when a patient tells you something is wrong.',
    ],
  },
  {
    title: 'Step-by-step instructions',
    mood: 'Instructive',
    cue: 'Calm and orderly. A small pause after each step.',
    paragraphs: [
      'Here is how to measure blood pressure correctly. First, let the patient sit quietly for five minutes. Second, support the arm at the level of the heart. Third, choose a cuff that fits the arm properly. Finally, record the reading and the arm you used.',
      'To perform hand hygiene, start by wetting your hands with clean water. Apply enough soap to cover every surface. Rub your palms together, then the backs of your hands. Clean between your fingers, around your thumbs, and under your nails. Rinse, dry thoroughly, and turn off the tap with a paper towel.',
      'When you present a patient, follow a simple order. Begin with their name, age and main complaint. Then describe the history, the examination and the key results. Finish with your assessment and your plan. Keep it short, clear and confident.',
    ],
  },
  {
    title: 'Calm reassurance',
    mood: 'Calm',
    cue: 'Slow, low and soothing. Long, relaxed pauses.',
    paragraphs: [
      'Let us slow down for a moment. Take a deep breath in, and let it out slowly. Exams can feel overwhelming, but you have prepared well. You know more than you think you do.',
      'If you feel stuck on a question, simply move on and come back to it later. Read each question carefully, all the way to the end. Trust your first instinct when you are unsure. And remember, one question will never decide your whole future.',
      'Rest is part of learning, not the opposite of it. Sleep well the night before. Eat something good in the morning. Then walk in calmly, and show what you know.',
    ],
  },
  {
    title: 'A little humour',
    mood: 'Light-hearted',
    cue: 'Playful and relaxed. It is fine to sound amused.',
    paragraphs: [
      'I promise this slide has fewer arrows than the last one. Well, slightly fewer. The Krebs cycle has been confusing students for generations, so you are in very good company. If it helps, even your lecturers drew it wrong the first time.',
      'Someone once asked me whether the appendix has any purpose at all. I told them it keeps surgeons employed on Saturday nights. To be fair, it may also store helpful gut bacteria. So perhaps we should be a little kinder to it.',
      'Coffee is not, officially, one of the major food groups. However, judging by the queue outside the library, many of you disagree. Just remember to drink some water too. Your kidneys will thank you.',
    ],
  },
  {
    title: 'Explaining a concept',
    mood: 'Engaged teaching',
    cue: 'Your best lecture voice: confident, varied, building the idea step by step.',
    paragraphs: [
      'Let us build the idea of homeostasis from the ground up. Your body constantly works to keep its internal conditions stable. Temperature, blood sugar, water and salt all have a target range. When something drifts away from that range, the body pushes it back.',
      'Every homeostatic system has three parts. A sensor detects the change. A control centre, often in the brain, decides what to do. An effector, such as a muscle or a gland, carries out the response.',
      'Take blood sugar as an example. After a meal, glucose rises in the blood. The pancreas senses this and releases insulin. Insulin helps cells take up glucose, so the level falls back toward normal.',
      'Now imagine the opposite situation, many hours after eating. Blood sugar starts to fall. The pancreas releases glucagon instead, and the liver releases stored glucose. Two hormones, working in opposite directions, keep the level remarkably steady.',
      'This is called negative feedback, and it is everywhere in physiology. The response always opposes the original change. Positive feedback is much rarer, and it amplifies the change instead. Childbirth and blood clotting are the classic examples.',
      'So when you meet a new disease, ask yourself a simple question. Which feedback loop has failed, and where exactly did it fail? Was it the sensor, the control centre, or the effector? That one question will untangle a surprising number of clinical problems.',
    ],
  },
  {
    title: 'Reading a clinical case',
    mood: 'Neutral',
    cue: 'Factual, even pace — like presenting on a ward round.',
    paragraphs: [
      'Mrs Tan is a 67-year-old retired teacher who presents with two days of shortness of breath. She has a past history of high blood pressure and type two diabetes. She takes metformin, amlodipine and a low dose of aspirin. She has no known drug allergies.',
      'On examination, she is alert but breathless at rest. Her heart rate is 112 beats per minute and irregular. Her blood pressure is 145 over 90, and her oxygen saturation is 91 percent on room air. There are fine crackles at both lung bases, and mild swelling of both ankles.',
      'Her electrocardiogram shows atrial fibrillation with a rapid ventricular response. The chest X-ray shows an enlarged heart and fluid in both lungs. Her blood tests show a raised natriuretic peptide and mildly reduced kidney function.',
      'The working diagnosis is acute heart failure, triggered by new atrial fibrillation. The plan is to give oxygen, start a diuretic, and control her heart rate. We will also review her need for anticoagulation and arrange an echocardiogram. She will be monitored closely on the cardiology ward overnight.',
    ],
  },
  {
    title: 'Wrapping up',
    mood: 'Warm and confident',
    cue: 'Encouraging and proud, slowing down toward the very end.',
    paragraphs: [
      'That brings us to the end of today\'s session. We covered a lot of ground, and you all did really well. Before next week, please review your notes and try the practice questions. Bring along anything that still feels unclear.',
      'Remember why you chose this path in the first place. Behind every topic we study, there is a real person who will one day need your care. Learn it well, for them. Thank you all very much, and I will see you next time.',
    ],
  },
];

const WORDS_PER_MINUTE = 125; // with the sentence pauses

function wordCount(paragraphs) {
  return paragraphs.join(' ').split(/\s+/u).filter(Boolean).length;
}

export const RECORDING_SCRIPT = [
  ...READING_SCRIPT.map((section) => ({ ...NEUTRAL_CUE, ...section })),
  ...PART_B,
].map((section, index) => ({
  ...section,
  id: `s${String(index + 1).padStart(2, '0')}`,
  minutes: Math.max(1, Math.round(wordCount(section.paragraphs) / WORDS_PER_MINUTE)),
}));

export const RECORDING_SCRIPT_MINUTES = Math.round(
  RECORDING_SCRIPT.reduce((sum, section) => sum + wordCount(section.paragraphs), 0) / WORDS_PER_MINUTE,
);
