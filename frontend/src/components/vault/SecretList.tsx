import { useMemo } from 'react';
import { Key, Clock, FileText, Folder, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { SecretListItem } from '../../api/client';

interface SecretListProps {
  secrets: SecretListItem[];
  selectedSecret: string | null;
  viewMode: 'list' | 'tree';
  onSelect: (name: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  children: Record<string, TreeNode>;
  isSecret: boolean;
  secret?: SecretListItem;
}

export default function SecretList({
  secrets,
  selectedSecret,
  viewMode,
  onSelect,
}: SecretListProps) {
  const tree = useMemo(() => {
    if (viewMode !== 'tree') return null;

    const root: TreeNode = {
      name: 'root',
      path: '',
      children: {},
      isSecret: false,
    };

    for (const secret of secrets) {
      const parts = secret.name.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const path = parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;

        if (!current.children[part]) {
          current.children[part] = {
            name: part,
            path,
            children: {},
            isSecret: isLast,
            secret: isLast ? secret : undefined,
          };
        } else if (isLast) {
          current.children[part].isSecret = true;
          current.children[part].secret = secret;
        }

        current = current.children[part];
      }
    }

    return root;
  }, [secrets, viewMode]);

  if (secrets.length === 0) {
    return (
      <div className="p-4 text-center text-dark-500 text-sm">
        No secrets found
      </div>
    );
  }

  if (viewMode === 'list') {
    return (
      <div className="px-2">
        {secrets.map((secret) => (
          <SecretListItem
            key={secret.name}
            secret={secret}
            isSelected={selectedSecret === secret.name}
            onClick={() => onSelect(secret.name)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="px-2">
      {tree && <TreeView node={tree} onSelect={onSelect} selectedSecret={selectedSecret} />}
    </div>
  );
}

interface SecretListItemProps {
  secret: SecretListItem;
  isSelected: boolean;
  onClick: () => void;
}

function SecretListItem({ secret, isSelected, onClick }: SecretListItemProps) {
  const parts = secret.name.split('/');
  const name = parts[parts.length - 1];
  const folder = parts.slice(0, -1).join('/');

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors mb-1',
        isSelected
          ? 'bg-primary-500/20 text-primary-400'
          : 'text-dark-300 hover:bg-dark-800'
      )}
    >
      <Key className="h-4 w-4 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        {folder && (
          <p className="text-xs text-dark-500 truncate">{folder}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        {secret.has_otp && (
          <span title="Has OTP">
            <Clock className="h-3 w-3 text-dark-500" />
          </span>
        )}
        {secret.has_notes && (
          <span title="Has notes">
            <FileText className="h-3 w-3 text-dark-500" />
          </span>
        )}
      </div>
    </button>
  );
}

interface TreeViewProps {
  node: TreeNode;
  onSelect: (name: string) => void;
  selectedSecret: string | null;
  depth?: number;
}

function TreeView({ node, onSelect, selectedSecret, depth = 0 }: TreeViewProps) {
  const children = Object.values(node.children).sort((a, b) => {
    // Folders first, then secrets
    if (a.isSecret !== b.isSecret) {
      return a.isSecret ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  if (depth === 0) {
    return (
      <>
        {children.map((child) => (
          <TreeView
            key={child.path}
            node={child}
            onSelect={onSelect}
            selectedSecret={selectedSecret}
            depth={1}
          />
        ))}
      </>
    );
  }

  const hasChildren = Object.keys(node.children).length > 0;
  const isSelected = selectedSecret === node.path;

  if (node.isSecret) {
    return (
      <button
        onClick={() => onSelect(node.path)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-left transition-colors mb-0.5',
          isSelected
            ? 'bg-primary-500/20 text-primary-400'
            : 'text-dark-300 hover:bg-dark-800'
        )}
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
      >
        <Key className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="text-sm truncate">{node.name}</span>
        {node.secret?.has_otp && (
          <Clock className="h-3 w-3 text-dark-500 ml-auto" />
        )}
      </button>
    );
  }

  return (
    <div className="mb-0.5">
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-dark-400"
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
      >
        <ChevronRight className="h-3 w-3 rotate-90" />
        <Folder className="h-3.5 w-3.5" />
        <span className="text-sm font-medium">{node.name}</span>
      </div>
      {hasChildren && (
        <div>
          {Object.values(node.children)
            .sort((a, b) => {
              if (a.isSecret !== b.isSecret) return a.isSecret ? 1 : -1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <TreeView
                key={child.path}
                node={child}
                onSelect={onSelect}
                selectedSecret={selectedSecret}
                depth={depth + 1}
              />
            ))}
        </div>
      )}
    </div>
  );
}
