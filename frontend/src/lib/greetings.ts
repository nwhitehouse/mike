export const GREETINGS = [
    "Let's get some legal work done, {name}!",
    "{name}, what's on the docket today?",
    "Another day, another matter, {name}.",
    "Motion to begin? {name}.",
    "All rise… {name} is in session!",
    "Let the record show you're back, {name}.",
    "What are we lawyering today, {name}?",
    "{name}, time to make the fine print finer.",
    "Back at it — where shall we start, {name}?",
    "{name}, shall we wrangle some words today?",
    "Good to see you, {name}. What's the matter?",
    "Somewhere, a clause needs you, {name}.",
    "Let's make some legal magic, {name}.",
    "Argue, advise, or analyse — your call, {name}.",
    "Awaiting your instructions, {name}.",
    "Ready to get into it, {name}?",
    "{name}'s back — let the proceedings begin.",
    "What shall we tackle first, {name}?",
    "Hey {name}, where would you like to begin?",
    "{name}, open that briefcase and let's get to work.",
    "Something legal this way comes… hi, {name}.",
    "Your counsel awaits, {name}.",
    "Pick a matter, any matter, {name}.",
    "{name}, let's make today productive.",
    "Briefs, bundles, or banter — you decide, {name}.",
    "Ready to rule the day, {name}?",
    "{name}, the gavel is in your hands.",
];

export function getRandomGreeting(name: string): string {
    const safeName = name.trim() || "there";
    const template = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    return template.replace(/\{name\}/g, safeName);
}
