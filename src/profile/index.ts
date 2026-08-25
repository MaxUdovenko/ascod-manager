import DataTable from "datatables.net-bs5";
import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";

export interface InnerFile {
  name: string;
  relativePath: string;
  size: number;
}

interface AscodCard {
  dir: string;
  path: string;
  docName: string;
  docType: string;
  docOrganisation: string;
  docSpan: string;
  docNumber: string;
  docDate: string;
  docDeadline: string[];
  docComments: string;
  briefDesc: string;
  docStatus: string;
}

interface AscodOptions {
  docTypes: string[];
  organisations: string[];
}

interface ProfileCallbacks {
  onBack: () => void;
  onRefresh: () => void;
  onRename: () => void;
}

const DOCUMENT_TYPES = [
  "Наказ",
  "Розпорядження",
  "Протокол",
  "Доповідна записка",
  "Лист",
  "Договір",
  "Угода",
  "Меморандум",
].sort((left, right) => left.localeCompare(right, "uk"));

const DOCUMENT_ORGANISATIONS = ["ДСНС", "НУЦЗУ", "МВС", "МОН", "ООН", "Черкаська ОДА"];
const DOCUMENT_SPANS = ["Внутрішній", "Вихідний", "Вхідний"];
const DOCUMENT_STATUSES = ["на виконанні", "виконано", "опрацювати"];
const IGNORED_FILE_LIST_NAMES = new Set([".DS_Store"]);

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character] ?? character,
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Сталася невідома помилка.";
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
}

function visibleFiles(files: InnerFile[]): InnerFile[] {
  return files.filter((file) => !IGNORED_FILE_LIST_NAMES.has(file.name));
}

function options(values: string[]): string {
  return values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
}

function numberOptions(start: number, end: number, pad = false): string {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
    .map((number) => {
      const value = pad ? String(number).padStart(2, "0") : String(number);
      return `<option value="${value}">${value}</option>`;
    })
    .join("");
}

function selectedNumberOptions(start: number, end: number, selected: string, pad = false): string {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
    .map((number) => {
      const value = pad ? String(number).padStart(2, "0") : String(number);
      return `<option value="${value}"${value === selected ? " selected" : ""}>${value}</option>`;
    })
    .join("");
}

function dateSelects(prefix: string, value = ""): string {
  const [year = "", month = "", day = ""] = value.split("-");
  const currentYear = new Date().getFullYear();
  return `
    <div class="metadata-date-selects">
      <select class="form-select" name="${prefix}_day" aria-label="День">
        <option value="">День</option>
        ${selectedNumberOptions(1, 31, day, true)}
      </select>
      <select class="form-select" name="${prefix}_month" aria-label="Місяць">
        <option value="">Місяць</option>
        ${selectedNumberOptions(1, 12, month, true)}
      </select>
      <select class="form-select" name="${prefix}_year" aria-label="Рік">
        <option value="">Рік</option>
        ${selectedNumberOptions(2019, currentYear, year)}
      </select>
    </div>`;
}

function deadlineRow(value = ""): string {
  return `
    <div class="metadata-deadline-row">
      ${dateSelects("doc_deadline", value)}
      <button class="btn btn-outline-danger metadata-deadline-remove" type="button" aria-label="Видалити строк">&times;</button>
    </div>`;
}

function customOptionEditor(kind: "doc_type" | "doc_organisation", label: string): string {
  return `
    <div class="metadata-custom-option" data-custom-editor="${kind}" hidden>
      <input class="form-control" type="text" maxlength="120" placeholder="${escapeHtml(label)}" />
      <button class="btn btn-sm btn-primary" type="button" data-custom-save="${kind}">Зберегти</button>
      <button class="btn btn-sm btn-light" type="button" data-custom-cancel="${kind}">Скасувати</button>
    </div>`;
}

function metadataModal(folderName: string): string {
  return `
    <div id="metadata-modal" class="metadata-modal" hidden>
      <div class="metadata-modal__backdrop" data-metadata-close></div>
      <section class="metadata-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="metadata-modal-title">
        <form id="metadata-form">
          <div class="metadata-modal__header">
            <div>
              <h2 id="metadata-modal-title">Метадані документа</h2>
              <p>${escapeHtml(folderName)}</p>
            </div>
            <button class="metadata-modal__close" type="button" aria-label="Закрити" data-metadata-close>&times;</button>
          </div>

          <div class="metadata-form-grid">
            <div class="metadata-field metadata-field--wide">
              <label class="form-label" for="metadata-doc-name">Назва документа</label>
              <input id="metadata-doc-name" class="form-control" name="doc_name" type="text" required />
            </div>
            <div class="metadata-field metadata-field--wide">
              <label class="form-label" for="metadata-brief-desc">Короткий опис</label>
              <textarea id="metadata-brief-desc" class="form-control" name="brief_desc" rows="3"></textarea>
            </div>
            <div class="metadata-field">
              <div class="metadata-select-heading">
                <label class="form-label mb-0" for="metadata-doc-type">Тип документа</label>
                <button class="btn btn-sm btn-outline-primary" type="button" data-custom-show="doc_type">Додати</button>
              </div>
              <select id="metadata-doc-type" class="form-select" name="doc_type" required>
                ${options(DOCUMENT_TYPES)}
              </select>
              ${customOptionEditor("doc_type", "Новий тип документа")}
            </div>
            <div class="metadata-field">
              <div class="metadata-select-heading">
                <label class="form-label mb-0" for="metadata-doc-organisation">Організація</label>
                <button class="btn btn-sm btn-outline-primary" type="button" data-custom-show="doc_organisation">Додати</button>
              </div>
              <select id="metadata-doc-organisation" class="form-select" name="doc_organisation" required>
                ${options(DOCUMENT_ORGANISATIONS)}
              </select>
              ${customOptionEditor("doc_organisation", "Нова організація")}
            </div>
            <div class="metadata-field">
              <label class="form-label" for="metadata-doc-span">Напрям</label>
              <select id="metadata-doc-span" class="form-select" name="doc_span" required>
                ${options(DOCUMENT_SPANS)}
              </select>
            </div>
            <div class="metadata-field">
              <label class="form-label" for="metadata-doc-status">Статус документа</label>
              <select id="metadata-doc-status" class="form-select" name="doc_status" required>
                ${DOCUMENT_STATUSES.map(
                  (status) =>
                    `<option value="${escapeHtml(status)}"${status === "опрацювати" ? " selected" : ""}>${escapeHtml(status)}</option>`,
                ).join("")}
              </select>
            </div>
            <div class="metadata-field">
              <label class="form-label" for="metadata-doc-number">Номер документа</label>
              <input id="metadata-doc-number" class="form-control" name="doc_number" type="text" />
            </div>
            <div class="metadata-field">
              <label class="form-label" for="metadata-doc-date">Дата документа</label>
              <div id="metadata-doc-date" class="metadata-date-selects">
                <select class="form-select" name="doc_date_day" aria-label="День">
                  <option value="">День</option>
                  ${numberOptions(1, 31, true)}
                </select>
                <select class="form-select" name="doc_date_month" aria-label="Місяць">
                  <option value="">Місяць</option>
                  ${numberOptions(1, 12, true)}
                </select>
                <select class="form-select" name="doc_date_year" aria-label="Рік">
                  <option value="">Рік</option>
                  ${numberOptions(2019, new Date().getFullYear())}
                </select>
              </div>
            </div>
            <div class="metadata-field metadata-field--wide">
              <div class="metadata-deadline-heading">
                <label class="form-label mb-0">Строки виконання</label>
                <button id="metadata-add-deadline" class="btn btn-sm btn-outline-primary" type="button">Додати дату</button>
              </div>
              <div id="metadata-deadlines" class="metadata-deadlines">${deadlineRow()}</div>
            </div>
            <div class="metadata-field metadata-field--wide">
              <label class="form-label" for="metadata-doc-comments">Коментарі</label>
              <textarea id="metadata-doc-comments" class="form-control" name="doc_comments" rows="4"></textarea>
            </div>
          </div>

          <div class="metadata-modal__actions">
            <button class="btn btn-light" type="button" data-metadata-close>Скасувати</button>
            <button id="metadata-submit" class="btn btn-primary" type="submit">Зберегти</button>
          </div>
        </form>
      </section>
    </div>`;
}

export function renderEmptyProfilePage(root: HTMLElement): void {
  root.innerHTML = '<div class="app-content profile-page" aria-label="Тека"></div>';
}

export function renderProfilePage(
  root: HTMLElement,
  folderName: string,
  folderPath: string,
  files: InnerFile[],
  callbacks: ProfileCallbacks,
): void {
  const tableFiles = visibleFiles(files);
  root.innerHTML = `
    <div class="app-content profile-page" aria-label="Тека">
      <div class="container-fluid">
        <div class="profile-heading">
          <div class="profile-heading__actions">
            <button id="profile-back" class="btn btn-outline-primary" type="button">До каталогів</button>
            <button id="profile-add-metadata" class="btn btn-primary" type="button">Додати метадані</button>
            <button id="profile-open-finder" class="btn btn-outline-primary" type="button">Відкрити у Finder</button>
            <button id="profile-rename-folder" class="btn btn-outline-secondary" type="button">Перейменувати</button>
          </div>
          <div class="profile-heading__title">
            <h1 class="mb-1">${escapeHtml(folderName)}</h1>
          </div>
        </div>
        <section class="card directory-card profile-files-card">
          <div class="card-body">
            <div class="table-responsive">
              <table id="folder-inner-files" class="table table-hover align-middle w-100">
                <thead>
                  <tr>
                    <th>Назва</th>
                    <th>Відносний шлях</th>
                    <th class="text-end">Розмір</th>
                    <th class="text-end">Дія</th>
                  </tr>
                </thead>
                <tbody>
                  ${tableFiles
                    .map(
                      (file) => `
                        <tr>
                          <td>
                            <button
                              class="profile-file-link"
                              type="button"
                              data-file-path="${escapeHtml(file.relativePath)}"
                              title="Відкрити системною програмою"
                            >${escapeHtml(file.name)}</button>
                          </td>
                          <td><code class="path-fragment">${escapeHtml(file.relativePath)}</code></td>
                          <td class="text-end">${formatFileSize(file.size)}</td>
                          <td class="text-end">
                            <button
                              class="btn btn-sm btn-outline-danger profile-file-delete"
                              type="button"
                              data-delete-file-path="${escapeHtml(file.relativePath)}"
                              data-delete-file-name="${escapeHtml(file.name)}"
                              title="Перемістити до кошика"
                            >До кошика</button>
                          </td>
                        </tr>`,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
      ${metadataModal(folderName)}
    </div>`;

  const fileTable = root.querySelector<HTMLTableElement>("#folder-inner-files");
  if (fileTable) {
    new DataTable(fileTable, {
      layout: {
        topStart: "pageLength",
        topEnd: "search",
        top2: {
          className: "pagination-top-right",
          features: ["paging"],
        },
        bottomStart: "info",
        bottomEnd: "paging",
      },
      order: [[1, "asc"]],
      pageLength: 10,
      lengthMenu: [10, 25, 50, 100],
      autoWidth: false,
      columnDefs: [
        { targets: 0, width: "30%" },
        { targets: 1, width: "45%" },
        { targets: 2, width: "15%" },
        { targets: 3, width: "10%", orderable: false, searchable: false },
      ],
      language: {
        emptyTable: "У теці ще немає файлів",
        info: "Показано _START_–_END_ з _TOTAL_",
        infoEmpty: "Немає файлів",
        infoFiltered: "(відфільтровано з _MAX_)",
        lengthMenu: "Показувати _MENU_",
        search: "Пошук:",
        zeroRecords: "Файлів за запитом не знайдено",
        paginate: {
          first: "Перша",
          last: "Остання",
          next: "Далі",
          previous: "Назад",
        },
      },
    });
  }

  root.querySelector<HTMLButtonElement>("#profile-back")?.addEventListener("click", callbacks.onBack);
  fileTable?.addEventListener("click", (event) => {
    const deleteButton = (event.target as HTMLElement).closest<HTMLButtonElement>(".profile-file-delete");
    if (deleteButton?.dataset.deleteFilePath) {
      void moveInnerFileToTrash(folderPath, deleteButton.dataset.deleteFilePath, deleteButton, callbacks);
      return;
    }

    const openButton = (event.target as HTMLElement).closest<HTMLButtonElement>(".profile-file-link");
    if (openButton?.dataset.filePath) void openInnerFile(folderPath, openButton.dataset.filePath);
  });
  root.querySelector<HTMLButtonElement>("#profile-add-metadata")?.addEventListener("click", () => {
    void openMetadataModal(root, folderPath);
  });
  root.querySelector<HTMLButtonElement>("#profile-open-finder")?.addEventListener("click", () => {
    void openFolderInFinder(folderPath);
  });
  root.querySelector<HTMLButtonElement>("#profile-rename-folder")?.addEventListener("click", callbacks.onRename);
  root.querySelectorAll<HTMLElement>("[data-metadata-close]").forEach((element) => {
    element.addEventListener("click", () => closeMetadataModal(root));
  });
  root.querySelector<HTMLButtonElement>("#metadata-add-deadline")?.addEventListener("click", () => {
    root.querySelector<HTMLElement>("#metadata-deadlines")?.insertAdjacentHTML("beforeend", deadlineRow());
  });
  root.querySelector<HTMLElement>("#metadata-deadlines")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".metadata-deadline-remove");
    if (!button) return;
    const rows = root.querySelectorAll(".metadata-deadline-row");
    if (rows.length === 1) {
      button
        .closest<HTMLElement>(".metadata-deadline-row")
        ?.querySelectorAll<HTMLSelectElement>("select")
        .forEach((select) => {
          select.value = "";
        });
    } else {
      button.closest(".metadata-deadline-row")?.remove();
    }
  });
  root.querySelector<HTMLFormElement>("#metadata-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveMetadata(root, folderPath);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-custom-show]").forEach((button) => {
    button.addEventListener("click", () => showCustomOptionEditor(root, button.dataset.customShow ?? ""));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-custom-cancel]").forEach((button) => {
    button.addEventListener("click", () => hideCustomOptionEditor(root, button.dataset.customCancel ?? ""));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-custom-save]").forEach((button) => {
    button.addEventListener("click", () => void saveCustomOption(root, button.dataset.customSave ?? ""));
  });
}

async function openInnerFile(folderPath: string, filePath: string): Promise<void> {
  try {
    await invoke("open_folder_file", {
      relativePath: folderPath,
      filePath,
    });
  } catch (error) {
    await message(errorMessage(error), {
      title: "Не вдалося відкрити файл",
      kind: "error",
    });
  }
}

async function openFolderInFinder(folderPath: string): Promise<void> {
  try {
    await invoke("open_folder_in_finder", {
      relativePath: folderPath,
    });
  } catch (error) {
    await message(errorMessage(error), {
      title: "Не вдалося відкрити теку у Finder",
      kind: "error",
    });
  }
}

async function moveInnerFileToTrash(
  folderPath: string,
  filePath: string,
  button: HTMLButtonElement,
  callbacks: ProfileCallbacks,
): Promise<void> {
  const fileName = button.dataset.deleteFileName ?? filePath;
  const confirmed = await confirm(`Перемістити файл «${fileName}» до кошика?`, {
    title: "Підтвердіть дію",
    kind: "warning",
  });
  if (!confirmed) return;

  button.disabled = true;
  const previousContent = button.innerHTML;
  button.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>';
  try {
    await invoke("move_folder_file_to_trash", {
      relativePath: folderPath,
      filePath,
    });
    callbacks.onRefresh();
  } catch (error) {
    button.disabled = false;
    button.innerHTML = previousContent;
    await message(errorMessage(error), {
      title: "Не вдалося перемістити файл до кошика",
      kind: "error",
    });
  }
}

function showCustomOptionEditor(root: HTMLElement, kind: string): void {
  const editor = root.querySelector<HTMLElement>(`[data-custom-editor="${kind}"]`);
  if (!editor) return;
  editor.hidden = false;
  editor.querySelector<HTMLInputElement>("input")?.focus();
}

function hideCustomOptionEditor(root: HTMLElement, kind: string): void {
  const editor = root.querySelector<HTMLElement>(`[data-custom-editor="${kind}"]`);
  if (!editor) return;
  editor.hidden = true;
  const input = editor.querySelector<HTMLInputElement>("input");
  if (input) input.value = "";
}

function setSelectOptions(select: HTMLSelectElement | null, values: string[], selected = ""): void {
  if (!select) return;
  const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right, "uk"));
  select.innerHTML = options(sorted);
  if (selected && sorted.includes(selected)) select.value = selected;
}

function fillMetadataOptions(root: HTMLElement, metadataOptions: AscodOptions): void {
  setSelectOptions(root.querySelector<HTMLSelectElement>('[name="doc_type"]'), metadataOptions.docTypes);
  setSelectOptions(
    root.querySelector<HTMLSelectElement>('[name="doc_organisation"]'),
    metadataOptions.organisations,
  );
}

async function saveCustomOption(root: HTMLElement, kind: string): Promise<void> {
  if (kind !== "doc_type" && kind !== "doc_organisation") return;
  const editor = root.querySelector<HTMLElement>(`[data-custom-editor="${kind}"]`);
  const input = editor?.querySelector<HTMLInputElement>("input");
  const value = input?.value.trim();
  if (!editor || !input || !value) {
    input?.focus();
    return;
  }

  const saveButton = editor.querySelector<HTMLButtonElement>("[data-custom-save]");
  if (saveButton) saveButton.disabled = true;
  try {
    const saved = await invoke<string>("add_ascod_option", { kind, value });
    const selectName = kind === "doc_type" ? "doc_type" : "doc_organisation";
    const select = root.querySelector<HTMLSelectElement>(`[name="${selectName}"]`);
    const currentValues = select ? Array.from(select.options, (option) => option.value) : [];
    setSelectOptions(select, [...currentValues, saved], saved);
    hideCustomOptionEditor(root, kind);
  } catch (error) {
    await message(errorMessage(error), {
      title: "Не вдалося додати значення",
      kind: "error",
    });
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function closeMetadataModal(root: HTMLElement): void {
  const modal = root.querySelector<HTMLDivElement>("#metadata-modal");
  if (modal) modal.hidden = true;
  hideCustomOptionEditor(root, "doc_type");
  hideCustomOptionEditor(root, "doc_organisation");
}

function fillMetadataForm(root: HTMLElement, card: AscodCard | null): void {
  const form = root.querySelector<HTMLFormElement>("#metadata-form");
  if (!form) return;
  form.reset();

  const setValue = (selector: string, value: string): void => {
    const field = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
    if (field) field.value = value;
  };
  if (card) {
    setValue('[name="doc_name"]', card.docName);
    setValue('[name="brief_desc"]', card.briefDesc);
    setValue('[name="doc_type"]', card.docType);
    setValue('[name="doc_organisation"]', card.docOrganisation);
    setValue('[name="doc_span"]', card.docSpan);
    setValue('[name="doc_number"]', card.docNumber);
    const [year = "", month = "", day = ""] = card.docDate.split("-");
    setValue('[name="doc_date_day"]', day);
    setValue('[name="doc_date_month"]', month);
    setValue('[name="doc_date_year"]', year);
    setValue('[name="doc_comments"]', card.docComments);
    setValue('[name="doc_status"]', card.docStatus);
  }

  const deadlines = root.querySelector<HTMLElement>("#metadata-deadlines");
  if (deadlines) {
    const values = card?.docDeadline.length ? card.docDeadline : [""];
    deadlines.innerHTML = values.map((date) => deadlineRow(date)).join("");
  }
}

function dateFromSelects(container: ParentNode, prefix: string): { date: string; partial: boolean } {
  const day = container.querySelector<HTMLSelectElement>(`[name="${prefix}_day"]`)?.value ?? "";
  const month = container.querySelector<HTMLSelectElement>(`[name="${prefix}_month"]`)?.value ?? "";
  const year = container.querySelector<HTMLSelectElement>(`[name="${prefix}_year"]`)?.value ?? "";
  const selectedParts = [day, month, year].filter(Boolean).length;
  return {
    date: selectedParts === 3 ? `${year}-${month}-${day}` : "",
    partial: selectedParts > 0 && selectedParts < 3,
  };
}

async function openMetadataModal(root: HTMLElement, folderPath: string): Promise<void> {
  const modal = root.querySelector<HTMLDivElement>("#metadata-modal");
  if (!modal) return;

  try {
    const [card, metadataOptions] = await Promise.all([
      invoke<AscodCard | null>("get_ascod_card", { relativePath: folderPath }),
      invoke<AscodOptions>("get_ascod_options"),
    ]);
    fillMetadataOptions(root, metadataOptions);
    fillMetadataForm(root, card);
    hideCustomOptionEditor(root, "doc_type");
    hideCustomOptionEditor(root, "doc_organisation");
    modal.hidden = false;
    requestAnimationFrame(() => root.querySelector<HTMLInputElement>("#metadata-doc-name")?.focus());
  } catch (error) {
    await message(errorMessage(error), {
      title: "Не вдалося відкрити метадані",
      kind: "error",
    });
  }
}

async function saveMetadata(root: HTMLElement, folderPath: string): Promise<void> {
  const form = root.querySelector<HTMLFormElement>("#metadata-form");
  const submit = root.querySelector<HTMLButtonElement>("#metadata-submit");
  if (!form || !submit) return;

  const formData = new FormData(form);
  const value = (name: string): string => String(formData.get(name) ?? "").trim();
  const docDate = dateFromSelects(form, "doc_date");
  if (docDate.partial) {
    await message("Для дати документа виберіть день, місяць і рік.", {
      title: "Неповна дата",
      kind: "warning",
    });
    return;
  }
  const docDeadlines = [];
  for (const row of Array.from(form.querySelectorAll<HTMLElement>(".metadata-deadline-row"))) {
    const deadline = dateFromSelects(row, "doc_deadline");
    if (deadline.partial) {
      await message("Для кожного строку виконання виберіть день, місяць і рік.", {
        title: "Неповна дата",
        kind: "warning",
      });
      return;
    }
    if (deadline.date) docDeadlines.push(deadline.date);
  }
  const metadata = {
    docName: value("doc_name"),
    briefDesc: value("brief_desc"),
    docType: value("doc_type"),
    docOrganisation: value("doc_organisation"),
    docSpan: value("doc_span"),
    docNumber: value("doc_number"),
    docDate: docDate.date,
    docDeadline: docDeadlines,
    docComments: value("doc_comments"),
    docStatus: value("doc_status"),
  };

  submit.disabled = true;
  submit.textContent = "Зберігаємо…";
  try {
    await invoke<AscodCard>("save_ascod_card", { relativePath: folderPath, metadata });
    closeMetadataModal(root);
  } catch (error) {
    await message(errorMessage(error), {
      title: "Не вдалося зберегти метадані",
      kind: "error",
    });
  } finally {
    submit.disabled = false;
    submit.textContent = "Зберегти";
  }
}
