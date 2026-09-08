export { default as EditorSidebar } from '@/modules/code-editor/EditorSidebar';
export { useEditorSidebar } from '@/modules/code-editor/hooks/useEditorSidebar';
export { default as MarkdownPreview } from '@/modules/code-editor/markdown/MarkdownPreview';
export { default as MermaidDiagram } from '@/modules/code-editor/markdown/MermaidDiagram';
// Fork: the chat's Markdown decides whether a linked file path can be
// previewed, so this crosses the module boundary through the barrel.
export { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';
