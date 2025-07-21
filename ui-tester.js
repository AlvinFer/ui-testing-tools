import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const PIXEL_DIFF_THRESHOLD = 0.1; // Allow some difference for dynamic content
const RESULT_DIR = path.join(__dirname, 'result');
const BASELINE_DIR = path.join(__dirname, 'baseline');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Utility functions
function log(message) {
  console.log(message);
}

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function ensureBaselineDir() {
  if (!fs.existsSync(BASELINE_DIR)) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
  }
}

function getBaselineFolders() {
  if (!fs.existsSync(BASELINE_DIR)) {
    return [];
  }
  return fs.readdirSync(BASELINE_DIR).filter(item => {
    const itemPath = path.join(BASELINE_DIR, item);
    return fs.statSync(itemPath).isDirectory();
  });
}

function categorizeFolders(folders) {
  const categorized = {};
  folders.forEach(folder => {
    const parts = folder.split('-');
    if (parts.length >= 2) {
      const date = parts[parts.length - 1];
      const website = parts.slice(0, -1).join('-');
      if (!categorized[website]) {
        categorized[website] = [];
      }
      categorized[website].push(date);
    }
  });
  return categorized;
}

function createSafeFileName(url) {
  try {
    const urlObj = new URL(url);
    let filename = urlObj.hostname + urlObj.pathname;
    filename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    filename = filename.replace(/_+/g, '_');
    filename = filename.replace(/^_|_$/g, '');
    return filename || 'index';
  } catch {
    return 'invalid_url';
  }
}

async function baselineMenu() {
  log('\n=== Baseline Menu ===');
  log('This feature is not yet implemented in this version.');
  log('Returning to main menu.');
  await mainMenu();
}

async function mainMenu() {
  log('\n=== UI Testing Tools ===');
  log('1. Baseline');
  log('2. Compare');
  log('3. Exit');
  const answer = await ask('\nSelect an option: ');
  if (answer === '1') {
    await baselineMenu();
  } else if (answer === '2') {
    await compareMenu();
  } else if (answer === '3') {
    log('Exiting UI Tester.');
    rl.close();
    process.exit(0);
  } else {
    log('Invalid selection. Exiting.');
    rl.close();
    process.exit(1);
  }
}

async function compareMenu() {
  ensureBaselineDir();
  if (!fs.existsSync(RESULT_DIR)) {
    fs.mkdirSync(RESULT_DIR);
  }
  const folders = getBaselineFolders();
  const categorized = categorizeFolders(folders);
  // Flatten options for selection
  const options = [];
  for (const website in categorized) {
    categorized[website].forEach(date => {
      options.push({ website, date });
    });
  }
  if (options.length === 0) {
    log('No baselines to compare. Returning to main menu.');
    await mainMenu();
    return;
  }
  log('\nSelect a baseline to compare:');
  options.forEach((opt, idx) => {
    log(`  [${idx + 1}] Website: ${opt.website}, Date: ${opt.date}`);
  });
  const answer = await ask('Enter number: ');
  const idx = parseInt(answer, 10);
  if (isNaN(idx) || idx < 1 || idx > options.length) {
    log('Invalid selection. Returning to main menu.');
    await mainMenu();
    return;
  }
  const selected = options[idx - 1];
  const folderName = `${selected.website}-${selected.date}`;
  const folderPath = path.join(BASELINE_DIR, folderName);
  const pagesPath = path.join(folderPath, 'pages.json');
  if (!fs.existsSync(pagesPath)) {
    log('Baseline pages.json not found. Returning to main menu.');
    await mainMenu();
    return;
  }
  const baselinePages = JSON.parse(fs.readFileSync(pagesPath, 'utf-8'));
  const successPages = baselinePages.filter(p => p.status === 'success');
  log(`\nComparing ${successPages.length} successful pages from baseline...`);
  // Prepare temp folder for new screenshots
  const tempFolder = path.join(folderPath, 'compare_' + Date.now());
  fs.mkdirSync(tempFolder);
  // Prepare for pixelmatch
  const pixelmatch = (await import('pixelmatch')).default;
  const PNG = (await import('pngjs')).PNG;
  let matchCount = 0;
  let changeCount = 0;
  const changedPages = [];
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const p of successPages) {
    try {
      await page.goto(p.url, { timeout: 10000000 });
      const fileName = createSafeFileName(p.url);
      const newScreenshot = path.join(tempFolder, `${fileName}.png`);
      await page.screenshot({ path: newScreenshot, fullPage: true });
      const baselineScreenshot = p.screenshotPath;
      if (fs.existsSync(baselineScreenshot)) {
        // Read both images
        const imgA = PNG.sync.read(fs.readFileSync(baselineScreenshot));
        const imgB = PNG.sync.read(fs.readFileSync(newScreenshot));
        // Prepare diff image
        const { width, height } = imgA;
        const diff = new PNG({ width, height });
        // Compare with threshold
        const diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, { threshold: PIXEL_DIFF_THRESHOLD });
        const diffPath = path.join(tempFolder, `${fileName}_diff.png`);
        fs.writeFileSync(diffPath, PNG.sync.write(diff));
        const percentDiff = diffPixels / (width * height);
        if (percentDiff < 0.01) { // less than 1% difference is considered a match
          matchCount++;
        } else {
          changeCount++;
          changedPages.push({ url: p.url, diff: diffPath, percentDiff: (percentDiff * 100).toFixed(2) });
        }
      } else {
        log(`Baseline screenshot not found for ${p.url}`);
      }
    } catch (err) {
      log(`Error comparing ${p.url}: ${err.message}`);
    }
  }
  await browser.close();
  // Generate report file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const reportFile = path.join(RESULT_DIR, `compare_${selected.website}_${selected.date}_${timestamp}.txt`);
  let report = '';
  report += '=== Compare Report ===\n';
  report += `Baseline: ${selected.website} (${selected.date})\n`;
  report += `Compared at: ${timestamp}\n`;
  report += `Total pages compared: ${successPages.length}\n`;
  report += `Pages matched: ${matchCount}\n`;
  report += `Pages changed: ${changeCount}\n`;
  if (changedPages.length > 0) {
    report += '\nChanged pages:\n';
    changedPages.forEach((c, i) => {
      report += `  [${i + 1}] ${c.url} (diff: ${c.diff}, diff: ${c.percentDiff}%)\n`;
    });
  }
  fs.writeFileSync(reportFile, report);
  log(`\n=== Compare Report ===`);
  log(`Report saved to: ${reportFile}`);
  log(`Total pages compared: ${successPages.length}`);
  log(`Pages matched: ${matchCount}`);
  log(`Pages changed: ${changeCount}`);
  if (changedPages.length > 0) {
    log('Changed pages:');
    changedPages.forEach((c, i) => log(`  [${i + 1}] ${c.url} (diff: ${c.diff}, diff: ${c.percentDiff}%)`));
  }
  log('Compare complete. Returning to main menu.');
  await mainMenu();
}

// Main execution entry point
async function main() {
  try {
    await mainMenu();
  } catch (error) {
    log(`Error: ${error.message}`);
    rl.close();
    process.exit(1);
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  log('\nExiting...');
  rl.close();
  process.exit(0);
});

// Start the application
main();