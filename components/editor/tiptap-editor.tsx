/**
 * TipTap rich-text editor wrapper.
 *
 * Source: pallio_ui_playbook (visit documentation, care plan editor).
 *
 * Auto-saves on blur via `onSave`. The parent owns the persistence
 * (debounced PATCH to the backend); this component only emits on
 * user-initiated edits.
 *
 * Returns the editor's JSON document — Pallio stores TipTap JSON in
 * the `document` JSONB column of `care_plan` and as `document_text`
 * on `visit` (we render it back via TipTap on read).
 */
"use client";

import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";

import { cn } from "@/lib/utils";

type TipTapEditorProps = {
  /** Initial document — TipTap JSON or empty. */
  initial?: JSONContent | null;
  /** Called with the JSON doc whenever editor content changes. */
  onChange?: (doc: JSONContent) => void;
  /** Called once when the editor blurs — useful for autosave. */
  onBlurSave?: (doc: JSONContent) => void;
  placeholder?: string;
  className?: string;
  /** True = read-only display mode, no toolbar. */
  readOnly?: boolean;
};

export function TipTapEditor({
  initial,
  onChange,
  onBlurSave,
  placeholder,
  className,
  readOnly,
}: TipTapEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({})],
    content: initial ?? undefined,
    editable: !readOnly,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
    onBlur: ({ editor }) => onBlurSave?.(editor.getJSON()),
    editorProps: {
      attributes: {
        class: cn(
          "min-h-[200px] prose prose-slate max-w-none px-3 py-2 focus:outline-none",
        ),
        "aria-label": placeholder ?? "Document content",
      },
    },
  });

  return (
    <div
      className={cn(
        "rounded-md border border-slate-300 bg-white",
        readOnly && "bg-slate-50",
        className,
      )}
    >
      {!readOnly && editor && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-200 bg-slate-50/50 rounded-t-md">
          <ToolbarButton
            label="B"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold (Ctrl+B)"
          />
          <ToolbarButton
            label="I"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic (Ctrl+I)"
          />
          <span className="w-px h-5 bg-slate-300 mx-1" aria-hidden />
          <ToolbarButton
            label="H2"
            active={editor.isActive("heading", { level: 2 })}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            title="Heading 2"
          />
          <ToolbarButton
            label="• List"
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet list"
          />
          <ToolbarButton
            label="1. List"
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            title="Numbered list"
          />
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

type ToolbarButtonProps = {
  label: string;
  active?: boolean;
  onClick: () => void;
  title?: string;
};

function ToolbarButton({ label, active, onClick, title }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "px-2 py-1 rounded text-xs font-medium transition-colors",
        "hover:bg-slate-200",
        active && "bg-slate-200 text-slate-900",
      )}
    >
      {label}
    </button>
  );
}
