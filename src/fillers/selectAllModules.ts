import { Page } from "puppeteer";

interface AccountModules {
  read: boolean;
  hear: boolean;
  write: boolean;
  speak: boolean;
}
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
export const selectAvailableModules = async (
  page: Page,
  modules: AccountModules
): Promise<{ status: boolean; message: string }> => {
  try {
    await page.waitForSelector("input.cs-checkbox__input", { timeout: 5000 });

    const moduleMapping: Record<string, boolean> = {
      reading: modules.read,
      listening: modules.hear,
      writing: modules.write,
      speaking: modules.speak,
    };

    console.log("Target module configuration:", modules);

    // Get initial visual state by checking CSS classes or aria attributes
    const initialState = await page.evaluate(() => {
      const checkboxes = document.querySelectorAll("input.cs-checkbox__input");
      return Array.from(checkboxes).map((checkbox: any) => {
        const id = checkbox.id.trim().toLowerCase();
        const parent = checkbox.closest('.cs-input__field');
        return {
          id: id,
          rawId: checkbox.id,
          checked: checkbox.checked,
          disabled: checkbox.disabled,
          parentClasses: parent ? parent.className : '',
          visuallyChecked: checkbox.checked, // Will verify this
        };
      });
    });

    console.log("Initial checkbox states:", initialState);

    const notAvailable: string[] = [];
    const processed: string[] = [];
    const needsAction: Array<{ rawId: string; moduleId: string; shouldBeChecked: boolean }> = [];

    // First pass: identify what needs to change
    for (const state of initialState) {
      const moduleId = state.id;

      if (!Object.keys(moduleMapping).includes(moduleId)) {
        console.log(`Skipping unknown module: ${moduleId}`);
        continue;
      }

      const shouldBeChecked = moduleMapping[moduleId];
      const isCurrentlyChecked = state.checked;
      const isDisabled = state.disabled;

      console.log(`\nAnalyzing ${moduleId}:`);
      console.log(`  Target: ${shouldBeChecked ? "CHECKED" : "UNCHECKED"}`);
      console.log(`  Current: ${isCurrentlyChecked ? "CHECKED" : "UNCHECKED"}`);
      console.log(`  Disabled: ${isDisabled}`);

      if (isDisabled) {
        if (shouldBeChecked) {
          notAvailable.push(moduleId);
          processed.push(`⚠️ ${moduleId} is fully booked`);
        } else {
          processed.push(`○ ${moduleId} is disabled (not needed)`);
        }
        continue;
      }

      if (shouldBeChecked !== isCurrentlyChecked) {
        needsAction.push({ rawId: state.rawId, moduleId, shouldBeChecked });
        console.log(`  ⚡ Will change state`);
      } else {
        console.log(`  ✓ Already correct`);
      }
    }

    // Second pass: make changes using actual user-like clicks
    if (needsAction.length > 0) {
      console.log(`\nMaking ${needsAction.length} changes...`);
      
      for (const action of needsAction) {
        console.log(`\nClicking ${action.moduleId}...`);
        
        // Use Puppeteer's click method instead of evaluate
        const selector = `input.cs-checkbox__input[id="${action.rawId.trim()}"]`;
        
        try {
          // Try clicking the checkbox input directly with Puppeteer
          await page.click(selector, { delay: 100 });
          await delay(300);
          
          // Verify the change
          const newState = await page.$eval(selector, (el: any) => el.checked);
          console.log(`  After click: ${newState ? "CHECKED" : "UNCHECKED"}`);
          
          if (newState === action.shouldBeChecked) {
            if (action.shouldBeChecked) {
              processed.push(`✅ Selected ${action.moduleId}`);
              console.log(`  ✅ Successfully selected`);
            } else {
              processed.push(`❌ Deselected ${action.moduleId}`);
              console.log(`  ❌ Successfully deselected`);
            }
          } else {
            console.log(`  ⚠️ Click didn't change state as expected`);
            processed.push(`⚠️ Failed to modify ${action.moduleId}`);
          }
        } catch (clickError) {
          console.error(`  ❌ Click error:`, clickError);
          
          // Fallback: try clicking via label
          try {
            await page.evaluate((rawId) => {
              const label = document.querySelector(`label[for="${rawId.trim()}"]`) as HTMLLabelElement;
              if (label) {
                label.click();
              }
            }, action.rawId);
            await delay(300);
            processed.push(`⚠️ Used fallback click for ${action.moduleId}`);
          } catch (fallbackError) {
            processed.push(`❌ Failed to click ${action.moduleId}`);
          }
        }
      }
    } else {
      console.log("\nNo changes needed - all checkboxes already in correct state");
      for (const state of initialState) {
        const moduleId = state.id;
        if (Object.keys(moduleMapping).includes(moduleId) && !state.disabled) {
          const shouldBeChecked = moduleMapping[moduleId];
          if (shouldBeChecked) {
            processed.push(`✓ ${moduleId} already selected`);
          } else {
            processed.push(`○ ${moduleId} already deselected`);
          }
        }
      }
    }

    // Force a visual refresh of the page
    await page.evaluate(() => {
      // Trigger reflow
      document.body.offsetHeight;
      // Dispatch a change event on the form
      const form = document.querySelector('form');
      if (form) {
        form.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Final verification
    const finalState = await page.evaluate(() => {
      const checkboxes = document.querySelectorAll("input.cs-checkbox__input");
      return Array.from(checkboxes).map((checkbox: any) => ({
        id: checkbox.id.trim().toLowerCase(),
        checked: checkbox.checked,
      }));
    });

    console.log("\n" + "=".repeat(50));
    console.log("FINAL VERIFICATION:");
    let allCorrect = true;
    finalState.forEach((state) => {
      const moduleKey = state.id as keyof typeof moduleMapping;
      if (moduleKey in moduleMapping) {
        const expected = moduleMapping[moduleKey];
        const match = expected === state.checked;
        if (!match) allCorrect = false;
        const icon = match ? "✅" : "❌";
        console.log(
          `  ${icon} ${state.id}: ${state.checked ? "CHECKED" : "UNCHECKED"} (expected: ${
            expected ? "CHECKED" : "UNCHECKED"
          })`
        );
      }
    });
    console.log("=".repeat(50));

    const success = notAvailable.length === 0 && allCorrect;
    const message = success
      ? "✅ All required modules are available and selected correctly."
      : notAvailable.length > 0
      ? `⚠️ Some required modules are fully booked: ${notAvailable.join(", ")}`
      : "⚠️ Some checkboxes are not in the expected state";

    console.log("\nSummary:");
    processed.forEach((msg) => console.log(`  ${msg}`));
    console.log(message);

    return { status: success, message };
  } catch (err) {
    const message = `❌ Error selecting modules: ${(err as Error).message}`;
    console.error(message);
    return { status: false, message };
  }
};