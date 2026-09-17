{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TypeApplications #-}
module CekArguments (parseArgument, UplcTerm) where

import Data.Bifunctor (first)
import Data.ByteString qualified as BS
import Data.Char (digitToInt, isHexDigit)
import Data.List (stripPrefix)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import PlutusCore qualified as PLC
import PlutusCore.Data qualified as PLC
import PlutusCore.MkPlc (mkConstant)
import Text.Read (readMaybe)
import UntypedPlutusCore qualified as UPLC

type UplcTerm = UPLC.Term PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun ()

parseArgument :: String -> Either String UplcTerm
parseArgument value
  | value == "unit" = Right $ mkConstant @() () ()
  | Just raw <- stripPrefix "integer:" value =
      maybe (Left "Invalid integer argument") (Right . mkConstant @Integer ()) $ readMaybe raw
  | Just raw <- stripPrefix "bool:" value = case raw of
      "true" -> Right $ mkConstant @Bool () True
      "false" -> Right $ mkConstant @Bool () False
      _ -> Left "Boolean arguments must be true or false"
  | Just raw <- stripPrefix "bytes:" value = mkConstant @BS.ByteString () <$> decodeHex raw
  | Just raw <- stripPrefix "string:" value = do
      bytes <- decodeHex raw
      text <- first (const "String argument is not valid UTF-8") $ Text.decodeUtf8' bytes
      Right $ mkConstant @Text () text
  | Just raw <- stripPrefix "data:" value = do
      bytes <- decodeHex raw
      text <- first (const "Data argument is not valid UTF-8") $ Text.decodeUtf8' bytes
      maybe (Left "Invalid Data argument. Use Plutus Data syntax such as I 42 or Constr 0 [I 1].")
        (Right . mkConstant @PLC.Data ()) (readMaybe $ Text.unpack text)
  | otherwise = Left $ "Unsupported argument encoding: " <> take 32 value

decodeHex :: String -> Either String BS.ByteString
decodeHex raw
  | odd (length raw) = Left "Hex argument must contain an even number of digits"
  | any (not . isHexDigit) raw = Left "Hex argument contains a non-hex character"
  | otherwise = Right . BS.pack $ pairs raw
  where
    pairs (a : b : rest) = fromIntegral (digitToInt a * 16 + digitToInt b) : pairs rest
    pairs _ = []
