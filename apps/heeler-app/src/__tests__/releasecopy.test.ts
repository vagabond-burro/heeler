import {it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
const root=resolve(process.cwd(),"../..");
it("release promises describe the final Gaussian recipes and stronger detail",()=>{
 const notes=readFileSync(resolve(root,"docs/whats-new.md"),"utf8").split("## 2026.3.1")[1].split("\n## ")[0];
 for(const stale of ["Sharpening's two methods no longer halo","texture gain at the same slider value is within about seven percent","so a replaced file is never shown with the old pictures","Metadata tab shows everything in the file","so Skin Softening and Hi Pass sharpening match a layer editor at the same numbers"]){expect(notes).not.toContain(stale);}
 expect(notes).toContain("Gaussian");expect(notes).toContain("JPEG");
 expect(notes).toContain("Screen approximates fine grain at Fit");
});
it("the chart editor uses US spelling in its customer copy",()=>{
 const source=readFileSync(resolve(root,"apps/heeler-app/src/ui/charteditor.tsx"),"utf8");
 for(const stale of ['aria-label="Colour as sRGB hex"','Filter colours by name','No grey control:'])expect(source).not.toContain(stale);
});
