// print.tsx's values and helpers that are not components, kept apart so
// print.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
/** The Print section's controls: one component, mounted by Develop's
 * Print section and by the graph inspector on the Print node (The
 * report: no copies between Adjustments and the graph). Grade with
 * its time, or the split pair with theirs; the paper's Dmax and
 * base; a toner by density with its strength and crossover. Every
 * hint says what the dial makes.*/


export const TONERS: { key: string; name: string; tip: string }[] = [
  { key: "selenium", name: "Selenium", tip: "Selenium: cools and deepens the shadows first, the highlights untouched until the crossover" },
  { key: "sepia", name: "Sepia", tip: "Sepia: warms the highlights first, a brown that reaches into the midtones as the crossover rises" },
  { key: "gold", name: "Gold", tip: "Gold: a blue-black in the shadows" },
  { key: "split", name: "Split", tip: "Split: sepia in the highlights over gold in the shadows, the crossover between them" },
];
