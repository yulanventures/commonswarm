import { CONTENT_ROLE_COPY, PERSONAL_PURPOSE_WARNING, type HouseholdPurpose } from "./household-access";
import type { ChoiceVM } from "./home-types";

/** One purpose card in the create form; supplied by the integration layer from PURPOSE_COPY. */
export interface PurposeOption {
  value: HouseholdPurpose;
  label: string;
  detail: string;
}

export interface NewWorkspaceVM {
  viewerName: string;
  viewerInitials: string;
  name: string;
  purpose: HouseholdPurpose | null;
  purposes: readonly PurposeOption[];
  busy?: boolean;
  error?: string | null;
}

export interface NewWorkspaceCallbacks {
  onNameInput: (name: string) => void;
  onPurposeSelect: (purpose: HouseholdPurpose) => void;
  onCreate: () => void;
}

/** The purpose choices used by the form; copy comes from the caller's PURPOSE_COPY. */
export function newWorkspacePurposeChoices(vm: NewWorkspaceVM): ChoiceVM<HouseholdPurpose> {
  return {
    name: "create-purpose",
    legend: "Who is it for?",
    value: vm.purpose,
    options: vm.purposes.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.detail,
      disabled: Boolean(vm.busy),
    })),
  };
}

/** Live preview heading (UI-SPEC 3.8). */
export function newWorkspacePreviewTitle(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? `Who'll be in ${trimmed}` : "Who'll be in your workspace";
}

/** The dashed invite slot hides for a personal workspace. */
export function newWorkspaceShowsInviteSlot(purpose: HouseholdPurpose | null): boolean {
  return purpose !== "personal";
}

/** The server refuses a later purpose change; keep that warning on the live form. */
export function newWorkspacePersonalWarning(purpose: HouseholdPurpose | null): string {
  return purpose === "personal" ? PERSONAL_PURPOSE_WARNING : "";
}

/** "Who's in it?" note depends on the chosen purpose (personal workspaces refuse invitations). */
export function newWorkspacePeopleHint(purpose: HouseholdPurpose | null): string {
  if (purpose === "personal") {
    return "Nobody else can be invited to this workspace.";
  }
  return "After you create it, you get an invite link to send yourself, by text or email.";
}

/** The line under the page title (the canvas New-Space subtitle, in what this form really does). */
export const NEW_WORKSPACE_SUBTITLE = "Name it and say who it is for. Your agents join after you create it.";

/** The preview's closing sentence and its legend (solid: in the workspace; dashed: added later). */
export const NEW_WORKSPACE_PREVIEW_NOTE =
  "Everyone keeps their own agents. In the workspace, people and agents can message each other, so nobody copies messages between apps.";
export const NEW_WORKSPACE_LEGEND = { member: "In the workspace", later: "Added later" } as const;

/** Create is allowed only with a non-empty name and a chosen purpose. */
export function newWorkspaceCanCreate(name: string, purpose: HouseholdPurpose | null): boolean {
  return name.trim().length > 0 && (purpose === "shared" || purpose === "personal");
}

const initials = (name: string): string =>
  name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toLocaleUpperCase() || "CS";

/** The canvas draws a person as one letter in a circle (the rail, the people list, the preview). */
const avatarLetter = (vm: NewWorkspaceVM): string =>
  Array.from(vm.viewerInitials || initials(vm.viewerName))[0] ?? "";

/** Pure DOM builder for the new-workspace form and live preview (UI-SPEC 3.8). */
export function buildNewWorkspaceForm(
  doc: Document,
  vm: NewWorkspaceVM,
  callbacks: NewWorkspaceCallbacks,
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "hm-new-workspace";

  const layout = doc.createElement("div");
  layout.className = "hm-new-workspace__layout";

  const formCard = doc.createElement("form");
  formCard.dataset.createForm = "";
  formCard.noValidate = true;
  formCard.addEventListener("submit", event => { event.preventDefault(); callbacks.onCreate(); });
  formCard.className = "hm-new-workspace__card";
  formCard.setAttribute("aria-labelledby", "hm-new-workspace-title");

  const title = doc.createElement("h1");
  title.id = "hm-new-workspace-title";
  title.tabIndex = -1;
  title.dataset.createTitle = "";
  title.className = "hm-new-workspace__title";
  title.textContent = "New workspace";
  const header = doc.createElement("header");
  header.className = "hm-new-workspace__header";
  const subtitle = doc.createElement("p");
  subtitle.className = "hm-new-workspace__subtitle";
  subtitle.textContent = NEW_WORKSPACE_SUBTITLE;
  header.append(title, subtitle);
  root.append(header);

  const nameLabel = doc.createElement("label");
  nameLabel.className = "hm-new-workspace__field";
  const nameLegend = doc.createElement("span");
  nameLegend.className = "hm-new-workspace__label";
  nameLegend.textContent = "Name";
  const nameInput = doc.createElement("input");
  nameInput.type = "text";
  nameInput.id = "dashboard-workspace-name";
  nameInput.name = "workspace-name";
  nameInput.maxLength = 80;
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameInput.required = true;
  nameInput.value = vm.name;
  nameInput.disabled = Boolean(vm.busy);
  nameInput.addEventListener("input", () => callbacks.onNameInput(nameInput.value));
  nameLabel.append(nameLegend, nameInput);
  formCard.append(nameLabel);

  const purposeField = doc.createElement("fieldset");
  const purposeChoices = newWorkspacePurposeChoices(vm);
  purposeField.className = "hm-new-workspace__purpose";
  /* The canvas draws the choices as compact pills right under the name, with no heading between:
     the legend stays the fieldset's accessible name, visually hidden. */
  const purposeLegend = doc.createElement("legend");
  purposeLegend.className = "visually-hidden";
  purposeLegend.textContent = purposeChoices.legend;
  purposeField.append(purposeLegend);

  const purposeList = doc.createElement("div");
  purposeList.className = "hm-new-workspace__purpose-list";
  /* What each choice does, outside the pills: every line until one is chosen, then the chosen one. */
  const purposeDetails = doc.createElement("div");
  purposeDetails.className = "hm-new-workspace__purpose-details";
  const details: HTMLElement[] = [];
  const showDetails = (chosen: string | null): void => {
    for (const line of details) line.hidden = chosen !== null && line.dataset.createPurposeDetail !== chosen;
  };

  for (const option of purposeChoices.options) {
    const card = doc.createElement("label");
    card.className = "hm-new-workspace__purpose-card";
    const input = doc.createElement("input");
    input.type = "radio";
    input.dataset.createPurpose = "";
    input.name = purposeChoices.name;
    input.value = option.value;
    input.checked = purposeChoices.value === option.value;
    input.disabled = Boolean(option.disabled);
    const detailId = `hm-new-workspace-purpose-${option.value}`;
    input.setAttribute("aria-describedby", detailId);
    input.addEventListener("change", () => {
      if (!input.checked) return;
      showDetails(option.value);
      callbacks.onPurposeSelect(option.value);
    });
    const check = doc.createElement("span");
    check.className = "hm-new-workspace__purpose-check";
    check.setAttribute("aria-hidden", "true"); check.textContent = "✓";
    const copy = doc.createElement("span");
    copy.className = "hm-new-workspace__purpose-copy";
    const strong = doc.createElement("strong");
    strong.textContent = option.label;
    copy.append(strong);
    card.append(input, check, copy);
    purposeList.append(card);

    const detail = doc.createElement("p");
    detail.className = "hm-new-workspace__purpose-detail";
    detail.id = detailId;
    detail.dataset.createPurposeDetail = option.value;
    const detailLabel = doc.createElement("strong");
    detailLabel.textContent = `${option.label}: `;
    detail.append(detailLabel, option.hint ?? "");
    details.push(detail);
    purposeDetails.append(detail);
  }
  showDetails(purposeChoices.value);
  purposeField.append(purposeList, purposeDetails);
  formCard.append(purposeField);

  const personalWarning = doc.createElement("p");
  personalWarning.className = "hm-new-workspace__note-hint";
  personalWarning.dataset.createPersonalWarning = "";
  personalWarning.setAttribute("aria-live", "polite");
  personalWarning.textContent = newWorkspacePersonalWarning(vm.purpose);
  formCard.append(personalWarning);

  const peopleNote = doc.createElement("div");
  peopleNote.className = "hm-new-workspace__note-block";
  const peopleHeading = doc.createElement("h2");
  peopleHeading.className = "hm-new-workspace__note-title";
  peopleHeading.textContent = "Who's in it?";
  const peopleRow = doc.createElement("div");
  peopleRow.className = "hm-new-workspace__person";
  const peopleAvatar = doc.createElement("span");
  peopleAvatar.className = "hm-new-workspace__avatar";
  peopleAvatar.setAttribute("aria-hidden", "true");
  peopleAvatar.textContent = avatarLetter(vm);
  const peopleYou = doc.createElement("p");
  peopleYou.className = "hm-new-workspace__row-copy";
  const peopleName = doc.createElement("span");
  peopleName.className = "hm-new-workspace__row-name";
  peopleName.textContent = vm.viewerName;
  const peopleSub = doc.createElement("span");
  peopleSub.className = "hm-new-workspace__row-sub";
  peopleSub.textContent = "You";
  peopleYou.append(peopleName, peopleSub);
  peopleRow.append(peopleAvatar, peopleYou);
  const peopleHint = doc.createElement("p");
  peopleHint.className = "hm-new-workspace__note-hint";
  peopleHint.textContent = newWorkspacePeopleHint(vm.purpose);
  peopleNote.append(peopleHeading, peopleRow, peopleHint);
  formCard.append(peopleNote);

  const agentsNote = doc.createElement("div");
  agentsNote.className = "hm-new-workspace__note-block";
  const agentsHeading = doc.createElement("h2");
  agentsHeading.className = "hm-new-workspace__note-title";
  agentsHeading.textContent = "Agents";
  /* The canvas row for an agent that comes along (64px, 36px agent square, name and a second line).
     Creating a workspace takes a name and a purpose only; agents join each workspace from their own
     app, so this row is the place they will take, not a checkbox the form cannot honour. */
  const agentsRow = doc.createElement("div");
  agentsRow.className = "hm-new-workspace__person hm-new-workspace__person--agent";
  const agentsSlot = doc.createElement("span");
  agentsSlot.className = "hm-new-workspace__orb hm-new-workspace__orb--dashed";
  agentsSlot.setAttribute("aria-hidden", "true");
  const agentsCopy = doc.createElement("p");
  agentsCopy.className = "hm-new-workspace__row-copy";
  const agentsName = doc.createElement("span");
  agentsName.className = "hm-new-workspace__row-name";
  agentsName.textContent = "Agents you add";
  const agentsHint = doc.createElement("span");
  agentsHint.className = "hm-new-workspace__row-sub";
  agentsHint.textContent = "Add agents after you create it, from the apps you use.";
  agentsCopy.append(agentsName, agentsHint);
  agentsRow.append(agentsSlot, agentsCopy);
  agentsNote.append(agentsHeading, agentsRow);
  formCard.append(agentsNote);

  const create = doc.createElement("button");
  create.type = "submit";
  create.dataset.createButton = "";
  create.className = "hm-new-workspace__create";
  create.textContent = "Create workspace";
  create.disabled = Boolean(vm.busy) || !newWorkspaceCanCreate(vm.name, vm.purpose);

  const footer = doc.createElement("div");
  footer.className = "hm-new-workspace__footer";
  footer.append(create);

  const access = doc.createElement("p"); access.dataset.createAccess = "";
  access.className = "hm-new-workspace__access";
  access.textContent = `Your access: ${CONTENT_ROLE_COPY.editor.label}. ${CONTENT_ROLE_COPY.editor.detail}`;
  footer.append(access);
  formCard.append(footer);
  {
    const error = doc.createElement("p");
    error.className = "hm-new-workspace__error";
    error.setAttribute("role", "alert");
    error.dataset.createError = "";
    error.textContent = vm.error ?? "";
    error.hidden = !vm.error;
    formCard.append(error);
  }

  const preview = doc.createElement("aside");
  preview.className = "hm-new-workspace__preview";
  preview.setAttribute("aria-live", "polite");

  const previewTitleEl = doc.createElement("h2");
  previewTitleEl.className = "hm-new-workspace__preview-title";
  previewTitleEl.textContent = newWorkspacePreviewTitle(vm.name);
  preview.append(previewTitleEl);

  const previewBox = doc.createElement("div");
  previewBox.className = "hm-new-workspace__preview-box";
  const previewList = doc.createElement("ul");
  previewList.className = "hm-new-workspace__preview-list";
  previewList.setAttribute("role", "list");

  const youItem = doc.createElement("li");
  youItem.className = "hm-new-workspace__preview-you";
  const avatar = doc.createElement("span");
  avatar.className = "hm-new-workspace__avatar";
  avatar.textContent = avatarLetter(vm);
  const youName = doc.createElement("span");
  youName.className = "hm-new-workspace__preview-name";
  const youStrong = doc.createElement("strong");
  youStrong.textContent = vm.viewerName;
  const youSub = doc.createElement("small");
  youSub.textContent = "You";
  youName.append(youStrong, youSub);
  youItem.append(avatar, youName);
  previewList.append(youItem);

  const agentItem = doc.createElement("li");
  agentItem.className = "hm-new-workspace__preview-slot hm-new-workspace__preview-slot--agents";
  const agentOrb = doc.createElement("span");
  agentOrb.className = "hm-new-workspace__orb hm-new-workspace__orb--dashed";
  agentOrb.setAttribute("aria-hidden", "true");
  const agentLabel = doc.createElement("span");
  agentLabel.textContent = "Agents you add";
  agentItem.append(agentOrb, agentLabel);
  previewList.append(agentItem);

  if (newWorkspaceShowsInviteSlot(vm.purpose)) {
    const inviteItem = doc.createElement("li");
    inviteItem.className = "hm-new-workspace__preview-slot hm-new-workspace__preview-slot--people";
    const inviteAvatar = doc.createElement("span");
    inviteAvatar.className = "hm-new-workspace__avatar hm-new-workspace__avatar--dashed";
    inviteAvatar.setAttribute("aria-hidden", "true");
    const inviteLabel = doc.createElement("span");
    inviteLabel.textContent = "People you invite";
    inviteItem.append(inviteAvatar, inviteLabel);
    previewList.append(inviteItem);
  }

  previewBox.append(previewList);
  preview.append(previewBox);

  const previewNote = doc.createElement("p");
  previewNote.className = "hm-new-workspace__preview-note";
  previewNote.textContent = NEW_WORKSPACE_PREVIEW_NOTE;
  const legend = doc.createElement("p");
  legend.className = "hm-new-workspace__legend";
  for (const [kind, label] of [["member", NEW_WORKSPACE_LEGEND.member], ["later", NEW_WORKSPACE_LEGEND.later]] as const) {
    const item = doc.createElement("span");
    item.className = "hm-new-workspace__legend-item";
    const mark = doc.createElement("span");
    mark.className = `hm-new-workspace__legend-mark hm-new-workspace__legend-mark--${kind}`;
    mark.setAttribute("aria-hidden", "true");
    const text = doc.createElement("span");
    text.textContent = label;
    item.append(mark, text);
    legend.append(item);
  }
  preview.append(previewNote, legend);
  layout.append(formCard, preview);
  root.append(layout);
  return root;
}
