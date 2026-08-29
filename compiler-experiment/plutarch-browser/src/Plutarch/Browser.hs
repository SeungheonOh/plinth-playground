module Plutarch.Browser (exportScript) where

import Data.ByteString qualified as ByteString
import Data.Char (isAlphaNum)
import Data.Text qualified as Text
import Plutarch.Script (Script (unScript))
import PlutusCore.Flat (flat)
import UntypedPlutusCore qualified as UPLC

-- | Export a compiled Plutarch script from 'Main.main' in the Flat format
-- consumed by the playground's decoder and CEK evaluator.
exportScript :: String -> Either Text.Text Script -> IO ()
exportScript requestedName result = do
  script <- either (ioError . userError . Text.unpack) pure result
  ByteString.writeFile outputName . flat . UPLC.UnrestrictedProgram .
    UPLC.programMapNames UPLC.fakeNameDeBruijn $
      unScript script
  where
    outputName = sanitize requestedName <> ".uplc-flat"

sanitize :: String -> String
sanitize requestedName =
  case map replace requestedName of
    "" -> "Plutarch"
    safeName -> safeName
  where
    replace character
      | isAlphaNum character || character == '-' || character == '_' = character
      | otherwise = '_'
