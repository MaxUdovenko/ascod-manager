import "datatables.net-bs5/css/dataTables.bootstrap5.min.css";

import DataTable, { type Api } from "datatables.net-bs5";
import { icon } from "../icons";

export interface DirectoryEntry {
  name: string;
  relativePath: string;
  depth: number;
  childCount: number;
  docName: string | null;
  docType: string | null;
  docOrganisation: string | null;
  docSpan: string | null;
  docStatus: string | null;
  docNumber: string | null;
  docDate: string | null;
}

interface CatalogueCallbacks {
  onOpenFolder: (relativePath: string, name: string) => void;
}

let catalogueTable: Api | null = null;

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

function directoryRows(directories: DirectoryEntry[]): string {
  return directories
    .map((directory) => {
      const statusRowClass =
        directory.docStatus?.trim().toLocaleLowerCase("uk") === "на виконанні"
          ? "directory-row--in-progress"
          : "";

      return `
        <tr class="${statusRowClass}">
          <td data-order="${escapeHtml(directory.name.toLocaleLowerCase("uk"))}">
            <button
              class="directory-name directory-name-button"
              type="button"
              data-path="${escapeHtml(directory.relativePath)}"
              data-name="${escapeHtml(directory.name)}"
            >
              ${icon("chevron", "tree-chevron")}
              <span class="directory-title-stack">
                <span class="directory-folder-name">${escapeHtml(directory.name)}</span>
                <span class="directory-document-name">${escapeHtml(directory.docName || "—")}</span>
              </span>
            </button>
          </td>
          <td>${escapeHtml(directory.docType || "—")}</td>
          <td>${escapeHtml(directory.docOrganisation || "—")}</td>
          <td>${escapeHtml(directory.docSpan || "—")}</td>
          <td>${escapeHtml(directory.docNumber || "—")}</td>
          <td data-order="${directory.docDate ? directory.docDate.replaceAll("-", "") : "0"}">
            ${escapeHtml(directory.docDate || "—")}
          </td>
        </tr>`;
    })
    .join("");
}

function filterOptions(values: Array<string | null>): string {
  const uniqueValues = [...new Set(values.map((value) => value || "—"))].sort((left, right) => {
    if (left === "—") return 1;
    if (right === "—") return -1;
    return left.localeCompare(right, "uk", { sensitivity: "base" });
  });

  return uniqueValues
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
}

export function destroyCatalogueTable(): void {
  catalogueTable?.destroy();
  catalogueTable = null;
}

export function renderCataloguePage(
  root: HTMLElement,
  directories: DirectoryEntry[],
  callbacks: CatalogueCallbacks,
): void {
  destroyCatalogueTable();
  const firstLevelDirectories = directories.filter((directory) => directory.depth === 0);
  const docTypeOptions = filterOptions(firstLevelDirectories.map((directory) => directory.docType));
  const organisationOptions = filterOptions(
    firstLevelDirectories.map((directory) => directory.docOrganisation),
  );
  const statusOptions = filterOptions(firstLevelDirectories.map((directory) => directory.docSpan));

  root.innerHTML = `
    <section class="card directory-card">
      <div class="card-body">
        <div class="table-responsive">
          <table id="directory-table" class="table table-hover align-middle w-100">
            <thead>
              <tr>
                <th id="directory-table-name-column">Назва</th>
                <th>DOC_TYPE</th>
                <th>Ор-я</th>
                <th>Статус</th>
                <th>Номер</th>
                <th>Дата</th>
              </tr>
              <tr class="directory-filter-row" data-dt-order="disable">
                <th></th>
                <th>
                  <label class="visually-hidden" for="doc-type-filter">Фільтр за типом документа</label>
                  <select
                    id="doc-type-filter"
                    class="form-select form-select-sm directory-column-filter"
                    data-column="1"
                  >
                    <option value="">Усі типи</option>
                    ${docTypeOptions}
                  </select>
                </th>
                <th>
                  <label class="visually-hidden" for="organisation-filter">Фільтр за організацією</label>
                  <select
                    id="organisation-filter"
                    class="form-select form-select-sm directory-column-filter"
                    data-column="2"
                  >
                    <option value="">Усі організації</option>
                    ${organisationOptions}
                  </select>
                </th>
                <th>
                  <label class="visually-hidden" for="status-filter">Фільтр за статусом</label>
                  <select
                    id="status-filter"
                    class="form-select form-select-sm directory-column-filter"
                    data-column="3"
                  >
                    <option value="">Усі статуси</option>
                    ${statusOptions}
                  </select>
                </th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>${directoryRows(firstLevelDirectories)}</tbody>
          </table>
        </div>
      </div>
    </section>`;

  const table = root.querySelector<HTMLTableElement>("#directory-table");
  if (table) {
    catalogueTable = new DataTable(table, {
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
      order: [[5, "desc"]],
      pageLength: 10,
      lengthMenu: [10, 25, 50, 100],
      autoWidth: false,
      columnDefs: [
        { targets: 0, width: "36%" },
        { targets: [1, 2, 3, 4, 5], width: "12.8%" },
      ],
      language: {
        emptyTable: "У каталозі ще немає вкладених папок",
        info: "Показано _START_–_END_ з _TOTAL_",
        infoEmpty: "Немає каталогів",
        infoFiltered: "(відфільтровано з _MAX_)",
        lengthMenu: "Показувати _MENU_",
        search: "Пошук:",
        zeroRecords: "Каталогів за запитом не знайдено",
        paginate: {
          first: "Перша",
          last: "Остання",
          next: "Далі",
          previous: "Назад",
        },
      },
    });

    root.querySelectorAll<HTMLSelectElement>(".directory-column-filter").forEach((select) => {
      select.addEventListener("change", () => {
        const columnIndex = Number(select.dataset.column);
        catalogueTable?.column(columnIndex).search(select.value, { exact: true }).draw();
      });
    });

    table.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const folderButton = target.closest<HTMLButtonElement>(".directory-name-button");
      if (folderButton?.dataset.path && folderButton.dataset.name) {
        callbacks.onOpenFolder(folderButton.dataset.path, folderButton.dataset.name);
      }
    });
  }
}
