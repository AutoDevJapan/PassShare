import { useState, useEffect } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  Edit2,
  Trash2,
  Clock,
  History,
  X,
  Check,
  RefreshCw,
} from 'lucide-react';
import { useSecret, useSecretActions, useHistory } from '../../hooks/useSecrets';
import api from '../../api/client';
import clsx from 'clsx';

interface SecretDetailProps {
  name: string;
  onClose: () => void;
  onDeleted: () => void;
}

export default function SecretDetail({ name, onClose, onDeleted }: SecretDetailProps) {
  const { secret, isLoading, error, refetch } = useSecret(name);
  const { deleteSecret, isLoading: isDeleting } = useSecretActions();
  const { history } = useHistory(name);

  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({
    password: '',
    data: {} as Record<string, string>,
    notes: '',
  });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [otpCode, setOtpCode] = useState<string | null>(null);
  const [otpCountdown, setOtpCountdown] = useState(30);

  useEffect(() => {
    if (secret) {
      setEditData({
        password: secret.password,
        data: { ...secret.data },
        notes: secret.notes || '',
      });
    }
  }, [secret]);

  useEffect(() => {
    if (!secret?.has_otp) return;

    const fetchOtp = async () => {
      try {
        const result = await api.getOtp(name);
        setOtpCode(result.otp);
        setOtpCountdown(30 - (Math.floor(Date.now() / 1000) % 30));
      } catch {
        setOtpCode(null);
      }
    };

    fetchOtp();
    const interval = setInterval(fetchOtp, 30000);
    return () => clearInterval(interval);
  }, [name, secret?.has_otp]);

  useEffect(() => {
    if (!otpCode) return;
    const timer = setInterval(() => {
      setOtpCountdown((c) => (c > 0 ? c - 1 : 30));
    }, 1000);
    return () => clearInterval(timer);
  }, [otpCode]);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteSecret(name);
      onDeleted();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const handleSave = async () => {
    try {
      await api.updateSecret(name, editData);
      setIsEditing(false);
      refetch();
    } catch (err) {
      console.error('Failed to save:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-6 w-6 text-dark-500 animate-spin" />
      </div>
    );
  }

  if (error || !secret) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400">{error || 'Secret not found'}</p>
        <button
          onClick={onClose}
          className="mt-4 text-primary-400 hover:text-primary-300"
        >
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-white">{name}</h2>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                onClick={handleSave}
                className="flex items-center gap-2 px-3 py-1.5 bg-primary-500 hover:bg-primary-600 text-white text-sm rounded-lg transition-colors"
              >
                <Check className="h-4 w-4" />
                Save
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="flex items-center gap-2 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-300 text-sm rounded-lg transition-colors"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setIsEditing(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-300 text-sm rounded-lg transition-colors"
              >
                <Edit2 className="h-4 w-4" />
                Edit
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-dark-700 hover:bg-red-500/20 text-dark-300 hover:text-red-400 text-sm rounded-lg transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="p-1.5 text-dark-500 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Password */}
      <div className="card p-4 mb-4">
        <label className="block text-xs text-dark-500 uppercase tracking-wider mb-2">
          Password
        </label>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <input
              type="text"
              value={editData.password}
              onChange={(e) => setEditData({ ...editData, password: e.target.value })}
              className="flex-1 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-white font-mono focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none"
            />
          ) : (
            <div className="flex-1 bg-dark-800 rounded-lg px-3 py-2 font-mono text-white">
              {showPassword ? secret.password : '••••••••••••'}
            </div>
          )}
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="p-2 text-dark-400 hover:text-white transition-colors"
          >
            {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
          <button
            onClick={() => copyToClipboard(secret.password, 'password')}
            className={clsx(
              'p-2 transition-colors',
              copied === 'password' ? 'text-green-400' : 'text-dark-400 hover:text-white'
            )}
          >
            {copied === 'password' ? (
              <Check className="h-5 w-5" />
            ) : (
              <Copy className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      {/* OTP */}
      {secret.has_otp && otpCode && (
        <div className="card p-4 mb-4">
          <label className="block text-xs text-dark-500 uppercase tracking-wider mb-2">
            One-Time Password
          </label>
          <div className="flex items-center gap-4">
            <div className="text-2xl font-mono font-bold text-primary-400 tracking-widest">
              {otpCode}
            </div>
            <div className="flex items-center gap-2 text-dark-500">
              <Clock className="h-4 w-4" />
              <span className="text-sm">{otpCountdown}s</span>
            </div>
            <button
              onClick={() => copyToClipboard(otpCode, 'otp')}
              className={clsx(
                'p-2 transition-colors ml-auto',
                copied === 'otp' ? 'text-green-400' : 'text-dark-400 hover:text-white'
              )}
            >
              {copied === 'otp' ? (
                <Check className="h-5 w-5" />
              ) : (
                <Copy className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Metadata */}
      {Object.keys(secret.data).length > 0 && (
        <div className="card p-4 mb-4">
          <label className="block text-xs text-dark-500 uppercase tracking-wider mb-3">
            Details
          </label>
          <div className="space-y-3">
            {Object.entries(secret.data).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-dark-400 text-sm w-24 flex-shrink-0">{key}</span>
                {isEditing ? (
                  <input
                    type="text"
                    value={editData.data[key] || ''}
                    onChange={(e) =>
                      setEditData({
                        ...editData,
                        data: { ...editData.data, [key]: e.target.value },
                      })
                    }
                    className="flex-1 bg-dark-800 border border-dark-700 rounded px-2 py-1 text-sm text-white focus:border-primary-500 outline-none"
                  />
                ) : (
                  <span className="flex-1 text-white text-sm">{value}</span>
                )}
                {!isEditing && (
                  <button
                    onClick={() => copyToClipboard(value, key)}
                    className={clsx(
                      'p-1 transition-colors',
                      copied === key ? 'text-green-400' : 'text-dark-500 hover:text-white'
                    )}
                  >
                    {copied === key ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {(secret.notes || isEditing) && (
        <div className="card p-4 mb-4">
          <label className="block text-xs text-dark-500 uppercase tracking-wider mb-2">
            Notes
          </label>
          {isEditing ? (
            <textarea
              value={editData.notes}
              onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
              rows={4}
              className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-white text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none resize-none"
            />
          ) : (
            <p className="text-dark-300 text-sm whitespace-pre-wrap">{secret.notes}</p>
          )}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <History className="h-4 w-4 text-dark-500" />
            <label className="text-xs text-dark-500 uppercase tracking-wider">
              History
            </label>
          </div>
          <div className="space-y-2">
            {history.slice(0, 5).map((entry) => (
              <div key={entry.revision} className="text-sm">
                <span className="text-dark-500">
                  {new Date(entry.date).toLocaleDateString()}
                </span>
                <span className="text-dark-400 ml-2">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-white mb-2">Delete Secret</h3>
            <p className="text-dark-400 mb-6">
              Are you sure you want to delete <strong className="text-white">{name}</strong>?
              This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-dark-300 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
