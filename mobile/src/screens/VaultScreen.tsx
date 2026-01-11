import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import api, { type SecretListItem, type SecretDetail } from '../services/api';

interface VaultScreenProps {
  navigation: any;
}

export default function VaultScreen({ navigation }: VaultScreenProps) {
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSecret, setSelectedSecret] = useState<SecretDetail | null>(null);

  const loadSecrets = useCallback(async () => {
    try {
      const response = await api.listSecrets();
      setSecrets(response.secrets);
    } catch (error) {
      Alert.alert('Error', 'Failed to load secrets');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    loadSecrets();
  };

  const handleSelectSecret = async (name: string) => {
    try {
      const secret = await api.getSecret(name);
      setSelectedSecret(secret);
    } catch (error) {
      Alert.alert('Error', 'Failed to load secret');
    }
  };

  const handleCopyPassword = async () => {
    if (selectedSecret) {
      await Clipboard.setStringAsync(selectedSecret.password);
      Alert.alert('Copied', 'Password copied to clipboard');
    }
  };

  const handleSync = async () => {
    try {
      const result = await api.syncStore();
      if (result.success) {
        Alert.alert('Success', 'Sync completed');
        loadSecrets();
      } else {
        Alert.alert('Error', result.message);
      }
    } catch (error) {
      Alert.alert('Error', 'Sync failed');
    }
  };

  const filteredSecrets = searchQuery
    ? secrets.filter((s) =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : secrets;

  const renderSecretItem = ({ item }: { item: SecretListItem }) => {
    const parts = item.name.split('/');
    const name = parts[parts.length - 1];
    const folder = parts.slice(0, -1).join('/');

    return (
      <TouchableOpacity
        style={styles.secretItem}
        onPress={() => handleSelectSecret(item.name)}
      >
        <View style={styles.secretIcon}>
          <Ionicons name="key" size={20} color="#10b981" />
        </View>
        <View style={styles.secretInfo}>
          <Text style={styles.secretName}>{name}</Text>
          {folder && <Text style={styles.secretFolder}>{folder}</Text>}
        </View>
        <View style={styles.secretBadges}>
          {item.has_otp && (
            <Ionicons name="time" size={16} color="#6b6b73" />
          )}
          {item.has_notes && (
            <Ionicons name="document-text" size={16} color="#6b6b73" />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (selectedSecret) {
    return (
      <SecretDetailView
        secret={selectedSecret}
        onBack={() => setSelectedSecret(null)}
        onCopy={handleCopyPassword}
      />
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Vault</Text>
        <TouchableOpacity onPress={handleSync} style={styles.syncButton}>
          <Ionicons name="sync" size={24} color="#10b981" />
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#6b6b73" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search secrets..."
          placeholderTextColor="#6b6b73"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {/* Secret List */}
      <FlatList
        data={filteredSecrets}
        renderItem={renderSecretItem}
        keyExtractor={(item) => item.name}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="key-outline" size={48} color="#3a3a3f" />
            <Text style={styles.emptyText}>
              {isLoading ? 'Loading...' : 'No secrets found'}
            </Text>
          </View>
        }
      />

      {/* Add Button */}
      <TouchableOpacity
        style={styles.addButton}
        onPress={() => navigation.navigate('AddSecret')}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

interface SecretDetailViewProps {
  secret: SecretDetail;
  onBack: () => void;
  onCopy: () => void;
}

function SecretDetailView({ secret, onBack, onCopy }: SecretDetailViewProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState<string | null>(null);

  useEffect(() => {
    if (secret.has_otp) {
      const fetchOtp = async () => {
        try {
          const result = await api.getOtp(secret.name);
          setOtp(result.otp);
        } catch {
          // OTP not available
        }
      };
      fetchOtp();
      const interval = setInterval(fetchOtp, 30000);
      return () => clearInterval(interval);
    }
  }, [secret.name, secret.has_otp]);

  return (
    <View style={styles.container}>
      <View style={styles.detailHeader}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.detailTitle} numberOfLines={1}>
          {secret.name}
        </Text>
      </View>

      <View style={styles.detailContent}>
        {/* Password */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Password</Text>
          <View style={styles.passwordRow}>
            <Text style={styles.passwordText}>
              {showPassword ? secret.password : '••••••••'}
            </Text>
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
              <Ionicons
                name={showPassword ? 'eye-off' : 'eye'}
                size={24}
                color="#6b6b73"
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={onCopy}>
              <Ionicons name="copy" size={24} color="#10b981" />
            </TouchableOpacity>
          </View>
        </View>

        {/* OTP */}
        {otp && (
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>One-Time Password</Text>
            <Text style={styles.otpText}>{otp}</Text>
          </View>
        )}

        {/* Metadata */}
        {Object.entries(secret.data).map(([key, value]) => (
          <View key={key} style={styles.field}>
            <Text style={styles.fieldLabel}>{key}</Text>
            <Text style={styles.fieldValue}>{value}</Text>
          </View>
        ))}

        {/* Notes */}
        {secret.notes && (
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Notes</Text>
            <Text style={styles.notesText}>{secret.notes}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0b',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingTop: 60,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
  },
  syncButton: {
    padding: 8,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    marginTop: 0,
    paddingHorizontal: 16,
    height: 44,
    backgroundColor: '#1a1a1d',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a2e',
  },
  searchIcon: {
    marginRight: 12,
  },
  searchInput: {
    flex: 1,
    color: '#fff',
    fontSize: 16,
  },
  list: {
    padding: 16,
    paddingTop: 0,
  },
  secretItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#111113',
    borderRadius: 12,
    marginBottom: 8,
  },
  secretIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  secretInfo: {
    flex: 1,
  },
  secretName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  secretFolder: {
    fontSize: 12,
    color: '#6b6b73',
    marginTop: 2,
  },
  secretBadges: {
    flexDirection: 'row',
    gap: 8,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyText: {
    color: '#6b6b73',
    marginTop: 16,
  },
  addButton: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#10b981',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingTop: 60,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1d',
  },
  backButton: {
    marginRight: 16,
  },
  detailTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
  },
  detailContent: {
    padding: 16,
  },
  field: {
    marginBottom: 24,
  },
  fieldLabel: {
    fontSize: 12,
    color: '#6b6b73',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1d',
    borderRadius: 12,
    padding: 16,
    gap: 16,
  },
  passwordText: {
    flex: 1,
    fontSize: 18,
    fontFamily: 'monospace',
    color: '#fff',
  },
  otpText: {
    fontSize: 32,
    fontFamily: 'monospace',
    fontWeight: 'bold',
    color: '#10b981',
    letterSpacing: 4,
  },
  fieldValue: {
    fontSize: 16,
    color: '#fff',
  },
  notesText: {
    fontSize: 14,
    color: '#9b9ba3',
    lineHeight: 20,
  },
});
