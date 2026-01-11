import { useState } from 'react';
import { Plus, Trash2, Eye, EyeOff, Wand2 } from 'lucide-react';
import { useSecretActions } from '../../hooks/useSecrets';
import api from '../../api/client';

interface SecretFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export default function SecretForm({ onSuccess, onCancel }: SecretFormProps) {
  const { createSecret, isLoading, error } = useSecretActions();
  
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [metadata, setMetadata] = useState<{ key: string; value: string }[]>([
    { key: 'username', value: '' },
    { key: 'url', value: '' },
  ]);
  const [notes, setNotes] = useState('');

  const handleAddMetadata = () => {
    setMetadata([...metadata, { key: '', value: '' }]);
  };

  const handleRemoveMetadata = (index: number) => {
    setMetadata(metadata.filter((_, i) => i !== index));
  };

  const handleUpdateMetadata = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...metadata];
    updated[index][field] = value;
    setMetadata(updated);
  };

  const handleGeneratePassword = async () => {
    try {
      const result = await api.generateStandalonePassword({
        length: 24,
        symbols: true,
      });
      setPassword(result.passwords[0]);
      setShowPassword(true);
    } catch (err) {
      console.error('Failed to generate password:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const data: Record<string, string> = {};
    for (const { key, value } of metadata) {
      if (key.trim() && value.trim()) {
        data[key.trim()] = value.trim();
      }
    }

    try {
      await createSecret({
        name: name.trim(),
        password,
        data,
        notes: notes.trim() || undefined,
      });
      onSuccess();
    } catch (err) {
      console.error('Failed to create secret:', err);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-xl">
      <h2 className="text-xl font-bold text-white mb-6">Add New Secret</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Name */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-dark-300 mb-2">
          Name / Path
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="email/gmail"
          required
          className="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-white placeholder-dark-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none"
        />
        <p className="mt-1 text-xs text-dark-500">
          Use forward slashes to organize secrets into folders
        </p>
      </div>

      {/* Password */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-dark-300 mb-2">
          Password
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 pr-10 text-white font-mono placeholder-dark-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-500 hover:text-white"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <button
            type="button"
            onClick={handleGeneratePassword}
            className="flex items-center gap-2 px-4 py-2 bg-dark-700 hover:bg-dark-600 text-dark-300 rounded-lg transition-colors"
            title="Generate password"
          >
            <Wand2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Metadata */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-dark-300">
            Additional Fields
          </label>
          <button
            type="button"
            onClick={handleAddMetadata}
            className="flex items-center gap-1 text-xs text-primary-400 hover:text-primary-300"
          >
            <Plus className="h-3 w-3" />
            Add Field
          </button>
        </div>
        <div className="space-y-2">
          {metadata.map((item, index) => (
            <div key={index} className="flex gap-2">
              <input
                type="text"
                value={item.key}
                onChange={(e) => handleUpdateMetadata(index, 'key', e.target.value)}
                placeholder="Key"
                className="w-32 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-dark-500 focus:border-primary-500 outline-none"
              />
              <input
                type="text"
                value={item.value}
                onChange={(e) => handleUpdateMetadata(index, 'value', e.target.value)}
                placeholder="Value"
                className="flex-1 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-dark-500 focus:border-primary-500 outline-none"
              />
              <button
                type="button"
                onClick={() => handleRemoveMetadata(index)}
                className="p-2 text-dark-500 hover:text-red-400 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-dark-300 mb-2">
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Additional notes..."
          className="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-white placeholder-dark-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none resize-none"
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isLoading || !name.trim() || !password}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? 'Saving...' : 'Save Secret'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2.5 bg-dark-700 hover:bg-dark-600 text-dark-300 rounded-lg transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
