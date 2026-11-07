import { createInterface } from "node:readline";

const rl = () =>
  createInterface({ input: process.stdin, output: process.stdout });

function ask(iface: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    iface.question(question, (answer) => resolve(answer.trim()));
  });
}

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const iface = rl();
  try {
    const answer = await ask(iface, `${question}${suffix}: `);
    return answer || defaultValue || "";
  } finally {
    iface.close();
  }
}

export async function promptSelect(question: string, options: readonly string[]): Promise<string> {
  const iface = rl();
  try {
    console.log(`\n${question}`);
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${i + 1}) ${options[i]}`);
    }
    for (;;) {
      const answer = await ask(iface, `Choose [1-${options.length}]: `);
      const idx = Number(answer) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
        return options[idx];
      }
      console.log(`  Invalid choice. Enter a number between 1 and ${options.length}.`);
    }
  } finally {
    iface.close();
  }
}

export async function promptConfirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const iface = rl();
  try {
    const answer = await ask(iface, `${question} (${hint}): `);
    if (!answer) return defaultYes;
    return answer.toLowerCase().startsWith("y");
  } finally {
    iface.close();
  }
}
