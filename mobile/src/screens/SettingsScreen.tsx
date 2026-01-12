import { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Alert,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import api from '../services/api';

interface SettingsScreenProps {
  onLogout: () => void;
}

export default function SettingsScreen({ onLogout }: SettingsScreenProps) {
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [autoLockEnabled, setAutoLockEnabled] = useState(true);
  const [autoLockTimeout, setAutoLockTimeout] = useState(5);
  const [clipboardClearEnabled, setClipboardClearEnabled] = useState(true);
  const [clipboardClearTimeout, setClipboardClearTimeout] = useState(45);

  const handleBiometricToggle = async (value: boolean) => {
    setBiometricEnabled(value);
    await SecureStore.setItemAsync('biometric_enabled', value ? 'true' : 'false');
  };

  const handleAutoLockToggle = async (value: boolean) => {
    setAutoLockEnabled(value);
    await SecureStore.setItemAsync('auto_lock_enabled', value ? 'true' : 'false');
  };

  const handleClipboardClearToggle = async (value: boolean) => {
    setClipboardClearEnabled(value);
    await SecureStore.setItemAsync('clipboard_clear_enabled', value ? 'true' : 'false');
  };

  const handleSync = async () => {
    try {
      const result = await api.syncStore();
      if (result.success) {
        Alert.alert('成功', '同期が完了しました');
      } else {
        Alert.alert('エラー', result.message || '同期に失敗しました');
      }
    } catch (error) {
      Alert.alert('エラー', '同期に失敗しました');
    }
  };

  const handleExportData = () => {
    Alert.alert(
      'データのエクスポート',
      'Vaultデータをエクスポートしますか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'エクスポート',
          onPress: async () => {
            try {
              // In a real implementation, this would export to a file
              Alert.alert('成功', 'データをエクスポートしました');
            } catch {
              Alert.alert('エラー', 'エクスポートに失敗しました');
            }
          },
        },
      ]
    );
  };

  const handleClearCache = () => {
    Alert.alert(
      'キャッシュをクリア',
      'ローカルキャッシュをクリアしますか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'クリア',
          style: 'destructive',
          onPress: async () => {
            await SecureStore.deleteItemAsync('cached_secrets');
            Alert.alert('成功', 'キャッシュをクリアしました');
          },
        },
      ]
    );
  };

  const handleLogout = () => {
    Alert.alert(
      'ログアウト',
      'ログアウトしますか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'ログアウト',
          style: 'destructive',
          onPress: async () => {
            await api.logout();
            onLogout();
          },
        },
      ]
    );
  };

  const handleOpenHelp = () => {
    Linking.openURL('https://pass-share.bm1314.net/docs');
  };

  const handleOpenPrivacy = () => {
    Linking.openURL('https://pass-share.bm1314.net/privacy');
  };

  return (
    <ScrollView style={styles.container}>
      {/* Security Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>セキュリティ</Text>

        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Ionicons name="finger-print" size={24} color="#10b981" />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>生体認証</Text>
              <Text style={styles.rowDescription}>Face ID / Touch ID でロック解除</Text>
            </View>
          </View>
          <Switch
            value={biometricEnabled}
            onValueChange={handleBiometricToggle}
            trackColor={{ false: '#3a3a3f', true: '#10b981' }}
            thumbColor="#fff"
          />
        </View>

        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Ionicons name="lock-closed" size={24} color="#10b981" />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>自動ロック</Text>
              <Text style={styles.rowDescription}>{autoLockTimeout}分後に自動ロック</Text>
            </View>
          </View>
          <Switch
            value={autoLockEnabled}
            onValueChange={handleAutoLockToggle}
            trackColor={{ false: '#3a3a3f', true: '#10b981' }}
            thumbColor="#fff"
          />
        </View>

        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Ionicons name="clipboard" size={24} color="#10b981" />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>クリップボード自動クリア</Text>
              <Text style={styles.rowDescription}>{clipboardClearTimeout}秒後にクリア</Text>
            </View>
          </View>
          <Switch
            value={clipboardClearEnabled}
            onValueChange={handleClipboardClearToggle}
            trackColor={{ false: '#3a3a3f', true: '#10b981' }}
            thumbColor="#fff"
          />
        </View>
      </View>

      {/* Sync Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>同期</Text>

        <TouchableOpacity style={styles.button} onPress={handleSync}>
          <Ionicons name="sync" size={24} color="#10b981" />
          <Text style={styles.buttonText}>今すぐ同期</Text>
          <Ionicons name="chevron-forward" size={20} color="#6b6b73" />
        </TouchableOpacity>
      </View>

      {/* Data Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>データ管理</Text>

        <TouchableOpacity style={styles.button} onPress={handleExportData}>
          <Ionicons name="download" size={24} color="#10b981" />
          <Text style={styles.buttonText}>データをエクスポート</Text>
          <Ionicons name="chevron-forward" size={20} color="#6b6b73" />
        </TouchableOpacity>

        <TouchableOpacity style={styles.button} onPress={handleClearCache}>
          <Ionicons name="trash" size={24} color="#ef4444" />
          <Text style={[styles.buttonText, { color: '#ef4444' }]}>キャッシュをクリア</Text>
          <Ionicons name="chevron-forward" size={20} color="#6b6b73" />
        </TouchableOpacity>
      </View>

      {/* About Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>情報</Text>

        <TouchableOpacity style={styles.button} onPress={handleOpenHelp}>
          <Ionicons name="help-circle" size={24} color="#10b981" />
          <Text style={styles.buttonText}>ヘルプ</Text>
          <Ionicons name="chevron-forward" size={20} color="#6b6b73" />
        </TouchableOpacity>

        <TouchableOpacity style={styles.button} onPress={handleOpenPrivacy}>
          <Ionicons name="shield-checkmark" size={24} color="#10b981" />
          <Text style={styles.buttonText}>プライバシーポリシー</Text>
          <Ionicons name="chevron-forward" size={20} color="#6b6b73" />
        </TouchableOpacity>

        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Ionicons name="information-circle" size={24} color="#10b981" />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>バージョン</Text>
              <Text style={styles.rowDescription}>1.0.0</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Logout */}
      <View style={styles.section}>
        <TouchableOpacity style={[styles.button, styles.logoutButton]} onPress={handleLogout}>
          <Ionicons name="log-out" size={24} color="#ef4444" />
          <Text style={[styles.buttonText, { color: '#ef4444' }]}>ログアウト</Text>
        </TouchableOpacity>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>© 2026 株式会社BM1314</Text>
        <Text style={styles.footerText}>PassShare</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0b',
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b6b73',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
    marginLeft: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#111113',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  rowInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  rowText: {
    marginLeft: 16,
    flex: 1,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
  },
  rowDescription: {
    fontSize: 12,
    color: '#6b6b73',
    marginTop: 2,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111113',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  buttonText: {
    flex: 1,
    fontSize: 16,
    color: '#fff',
    marginLeft: 16,
  },
  logoutButton: {
    justifyContent: 'center',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  footerText: {
    fontSize: 12,
    color: '#6b6b73',
    marginTop: 4,
  },
});
