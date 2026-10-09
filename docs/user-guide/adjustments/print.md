# Print

The paper the print is made on. Levels and Curves shape the negative into the print; Print is the paper itself, in the display domain, last in the chain before Output. It is built for the black and white treatment, where the picture arriving is the negative on an ideal grade 2 paper, but it is safe on any photograph: a color picture is printed by its brightness and keeps its color.

Print ships off; the switch turns the paper on.

![Print section](../assets/screenshots/section-print.png)

## Paper

**Grade** is the paper's contrast, 0 to 5, about middle gray: 2 is the normal print, 0 gathers the tones and 5 spreads them. **Time** is the exposure on the paper in stops: more time is a darker print.

**Split** replaces the one grade with the printer's pair: **Soft** is a grade 0 exposure that lays tone from the highlights down, **Hard** a grade 5 exposure that builds the shadows, each with its own time. Set Soft for the light tones, then Hard for the dark, the way it is done under the enlarger. The two add as light on one sheet, so a lot of Hard reaches the highlights too, as it does on real paper, and the print always keeps its tonal order.

**Dmax** is the paper's deepest black as a density, about 2.1 for a glossy fiber paper and 1.7 for matte. The print's black is the paper's, not the screen's, so the deepest shadows keep a little light the way a print does.

**Base** is the paper's white, cold-toned to the left and warm-toned to the right, on every reflected value.

## Toner

Toning is a color by density, not by hue band, which is what separates it from a color grade: a toning bath takes the silver where the silver is. **Selenium** cools and deepens the shadows first. **Sepia** warms the highlights first. **Gold** is a blue-black in the shadows. **Split** is sepia in the highlights over gold in the shadows. **Toning** is how far the bath has taken the print, and **Crossover** is the density where a toner hands over: low lets a shadow toner climb into the midtones, high keeps it to the deepest blacks, and for sepia the reverse.

## Where it stands

The same node the graph shows, with the same controls. The paper is a model of how a print behaves, with grades, black densities and toner colors chosen from general knowledge of those families. These parameters have not been fitted to a measured sheet.
