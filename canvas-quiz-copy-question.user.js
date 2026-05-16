// ==UserScript==
// @name         Canvas Quiz - Copy Question
// @namespace    https://canvas.auckland.ac.nz/
// @version      0.3.3
// @description  Adds a button beside each Canvas quiz question number to copy the question text and answer options.
// @match        https://canvas.auckland.ac.nz/courses/*/quizzes/*
// @match        file:///*
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas-quiz-copy-question.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas-quiz-copy-question.user.js
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  "use strict";

  const BUTTON_CLASS = "tm-copy-question";
  const COPIED_CLASS = "tm-copy-question--copied";
  const HIDDEN_CLASS = "tm-copy-question--hidden";
  const TOGGLE_BUTTON_CLASS = "tm-copy-question-toggle";
  let copyButtonsVisible = true;

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function unique(values) {
    const seen = new Set();
    return values.filter((value) => {
      if (!value || seen.has(value)) {
        return false;
      }

      seen.add(value);
      return true;
    });
  }

  function getQuestionTitle(questionEl) {
    return normalizeText(getQuestionNameEl(questionEl)?.textContent || "Question");
  }

  function getQuestionText(questionEl) {
    const questionTextEl = questionEl.querySelector(".question_text");
    return normalizeText(questionTextEl?.textContent || "");
  }

  function getSelectOptions(selectEl) {
    return Array.from(selectEl.options)
      .map((option) => normalizeText(option.textContent || ""))
      .filter((text, index) => {
        const option = selectEl.options[index];
        return text && option.value && !/^\[\s*choose\s*\]$/i.test(text);
      });
  }

  function getLabelForSelect(answerEl, selectEl) {
    if (selectEl.id && window.CSS && typeof window.CSS.escape === "function") {
      return answerEl.querySelector(`label[for="${window.CSS.escape(selectEl.id)}"]`);
    }

    if (selectEl.id) {
      return Array.from(answerEl.querySelectorAll("label")).find((label) => label.htmlFor === selectEl.id);
    }

    return answerEl.querySelector("label");
  }

  function getMatchingRows(questionEl) {
    return Array.from(questionEl.querySelectorAll(".answers .answer"))
      .map((answerEl) => {
        const selectEl = answerEl.querySelector("select");
        const labelEl = selectEl ? getLabelForSelect(answerEl, selectEl) : null;

        if (!selectEl || !labelEl) {
          return null;
        }

        return {
          item: normalizeText(labelEl.textContent || ""),
          options: unique(getSelectOptions(selectEl)),
        };
      })
      .filter(Boolean);
  }

  function formatMatchingQuestion(questionEl) {
    const rows = getMatchingRows(questionEl);

    if (!rows.length) {
      return "";
    }

    const signatures = unique(rows.map((row) => row.options.join("\u001f")));
    const allDropdownsAreSame = signatures.length === 1;

    if (allDropdownsAreSame) {
      const items = rows.map((row) => `- ${row.item}`);
      const options = rows[0].options.map((option) => `- ${option}`);

      return [
        "Items:",
        ...items,
        "",
        "Choose options:",
        ...options,
      ].join("\n");
    }

    return [
      "Items:",
      ...rows.map((row) => `- ${row.item} [ ${row.options.join(" / ")} ]`),
    ].join("\n");
  }

  function getChoiceAnswers(questionEl) {
    return Array.from(questionEl.querySelectorAll(".answers .answer"))
      .map((answerEl) => {
        const answerLabel = answerEl.querySelector(".answer_label");

        if (answerLabel) {
          return normalizeText(answerLabel.textContent || "");
        }

        const label = answerEl.querySelector("label.answer_row");
        if (!label) {
          return "";
        }

        const clone = label.cloneNode(true);
        clone.querySelectorAll("input, .answer_input, .screenreader-only").forEach((node) => node.remove());
        return normalizeText(clone.textContent || "");
      })
      .filter(Boolean);
  }

  function formatChoiceQuestion(questionEl) {
    const choices = unique(getChoiceAnswers(questionEl));

    if (!choices.length) {
      return "";
    }

    return [
      "Answer choices:",
      ...choices.map((choice) => `- ${choice}`),
    ].join("\n");
  }

  function formatFreeResponseQuestion(questionEl) {
    const freeResponseInput = questionEl.querySelector(
      ".answers input[type='text'], .answers input[type='number'], .answers textarea"
    );

    return freeResponseInput ? "Answer: [free response]" : "";
  }

  function formatQuestionForPrompt(questionEl) {
    const parts = [
      getQuestionTitle(questionEl),
      "",
      getQuestionText(questionEl),
    ];

    const matchingText = formatMatchingQuestion(questionEl);
    const choiceText = matchingText ? "" : formatChoiceQuestion(questionEl);
    const freeResponseText = matchingText || choiceText ? "" : formatFreeResponseQuestion(questionEl);
    const answerText = matchingText || choiceText || freeResponseText;

    if (answerText) {
      parts.push("", answerText);
    }

    return parts.filter((part, index) => part || index === 1).join("\n");
  }

  async function copyText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text, "text");
      return;
    }

    await navigator.clipboard.writeText(text);
  }

  function flashButton(button, label, className) {
    const originalText = button.textContent;
    button.textContent = label;
    button.classList.add(className);

    window.setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove(className);
    }, 1500);
  }

  function getQuestionNameEl(questionEl) {
    return questionEl.querySelector(".header .question_name, .question_name, [role='heading'][aria-level='2']");
  }

  function getQuestionElements() {
    const canvasClassicQuestions = Array.from(document.querySelectorAll(".display_question"));

    if (canvasClassicQuestions.length) {
      return canvasClassicQuestions;
    }

    return Array.from(document.querySelectorAll("[id^='question_'], [data-testid*='question']"))
      .filter((element) => getQuestionNameEl(element) || element.querySelector(".question_text, .answers"));
  }

  function addStyles() {
    const css = `
      .${BUTTON_CLASS} {
        margin-left: 10px;
        padding: 3px 8px;
        border: 1px solid #8f98a3;
        border-radius: 4px;
        background: #fff;
        color: #2d3b45;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.4;
        vertical-align: middle;
      }

      .${BUTTON_CLASS}:hover {
        background: #f5f7f9;
        border-color: #6b7785;
      }

      .${BUTTON_CLASS}.${COPIED_CLASS} {
        border-color: #0b874b;
        color: #0b874b;
      }

      .${BUTTON_CLASS}.${HIDDEN_CLASS} {
        display: none !important;
      }

      .${TOGGLE_BUTTON_CLASS} {
        position: fixed;
        top: 10px;
        right: 14px;
        z-index: 10000;
        padding: 6px 10px;
        border: 1px solid #8f98a3;
        border-radius: 4px;
        background: #fff;
        color: #2d3b45;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.4;
      }

      .${TOGGLE_BUTTON_CLASS}:hover {
        background: #f5f7f9;
        border-color: #6b7785;
      }

      .display_question .answers select.question_input {
        width: 180% !important;
        min-width: 320px;
        max-width: calc(100vw - 96px) !important;
      }
    `;

    if (typeof GM_addStyle === "function") {
      GM_addStyle(css);
      return;
    }

    const styleEl = document.createElement("style");
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  function updateCopyButtonVisibility() {
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => {
      button.classList.toggle(HIDDEN_CLASS, !copyButtonsVisible);
    });

    const toggleButton = document.querySelector(`.${TOGGLE_BUTTON_CLASS}`);
    if (toggleButton) {
      toggleButton.textContent = copyButtonsVisible ? "Hide copy buttons" : "Show copy buttons";
      toggleButton.setAttribute("aria-pressed", String(!copyButtonsVisible));
    }
  }

  function addToggleButton() {
    if (document.querySelector(`.${TOGGLE_BUTTON_CLASS}`)) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = TOGGLE_BUTTON_CLASS;
    button.title = "Toggle all question copy buttons";
    button.addEventListener("click", () => {
      copyButtonsVisible = !copyButtonsVisible;
      updateCopyButtonVisibility();
    });

    document.body.appendChild(button);
    updateCopyButtonVisibility();
  }

  function addCopyButtons() {
    getQuestionElements().forEach((questionEl) => {
      const questionName = getQuestionNameEl(questionEl);

      if (!questionName || questionName.parentElement.querySelector(`.${BUTTON_CLASS}`)) {
        return;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.textContent = "Copy question";
      button.title = "Copy this question and answer options";

      button.addEventListener("click", async () => {
        const text = formatQuestionForPrompt(questionEl);

        if (!text) {
          flashButton(button, "Nothing found", COPIED_CLASS);
          return;
        }

        try {
          await copyText(text);
          flashButton(button, "Copied", COPIED_CLASS);
        } catch (error) {
          console.error("Could not copy question", error);
          flashButton(button, "Copy failed", COPIED_CLASS);
        }
      });

      questionName.insertAdjacentElement("afterend", button);
    });

    updateCopyButtonVisibility();
  }

  function start() {
    addStyles();

    if (!document.body) {
      window.setTimeout(start, 100);
      return;
    }

    addToggleButton();
    addCopyButtons();

    const observer = new MutationObserver(addCopyButtons);
    observer.observe(document.body, { childList: true, subtree: true });
    window.setInterval(addCopyButtons, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
